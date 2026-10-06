export interface ZipStreamEntry {
  name: string;
  sizeBytes: number;
  /** Maximum time allowed for one upstream body read to make progress. */
  readTimeoutMs?: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
}

type CentralEntry = {
  name: Uint8Array;
  size: number;
  crc: number;
  localOffset: number;
};

const ZIP32_MAX = 0xffff_ffff;
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function validateEntries(entries: readonly ZipStreamEntry[]): void {
  if (entries.length < 1 || entries.length > 12) {
    throw new Error("zip_entry_count_invalid");
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (
      !/^[A-Za-z0-9_.-]{1,120}$/u.test(entry.name) ||
      names.has(entry.name) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > ZIP32_MAX
    ) {
      throw new Error("zip_entry_invalid");
    }
    names.add(entry.name);
  }
}

function updateCrc(crc: number, bytes: Uint8Array): number {
  let next = crc;
  for (const byte of bytes) {
    next = (CRC_TABLE[(next ^ byte) & 0xff] ?? 0) ^ (next >>> 8);
  }
  return next >>> 0;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("zip_read_timeout")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function localFileHeader(name: Uint8Array): Buffer {
  const header = Buffer.alloc(30 + name.byteLength);
  header.writeUInt32LE(0x0403_4b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 name
  header.writeUInt16LE(0, 8); // stored, no compression
  header.writeUInt16LE(0, 10); // deterministic DOS time
  header.writeUInt16LE(0x0021, 12); // 1980-01-01
  header.writeUInt32LE(0, 14); // CRC follows in the data descriptor
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  Buffer.from(name).copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x0807_4b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralDirectoryHeader(entry: CentralEntry): Buffer {
  const header = Buffer.alloc(46 + entry.name.byteLength);
  header.writeUInt32LE(0x0201_4b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  header.writeUInt16LE(0, 30); // extra length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(entry.localOffset, 42);
  Buffer.from(entry.name).copy(header, 46);
  return header;
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

/**
 * Stream a ZIP32 archive without buffering or recompressing its video files.
 * Entries are expected to have been size-checked before headers are sent.
 */
export async function* streamStoredZipEntries(
  entries: readonly ZipStreamEntry[],
): AsyncGenerator<Uint8Array> {
  validateEntries(entries);
  const centralEntries: CentralEntry[] = [];
  let offset = 0;
  let totalPayloadBytes = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const localOffset = offset;
    const header = localFileHeader(name);
    yield header;
    offset += header.byteLength;

    let crc = 0xffff_ffff;
    let size = 0;
    const reader = (await entry.open()).getReader();
    const readTimeoutMs = entry.readTimeoutMs ?? 60_000;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await readWithTimeout(reader, readTimeoutMs);
        if (done) {
          completed = true;
          break;
        }
        if (!(value instanceof Uint8Array))
          throw new Error("zip_chunk_invalid");
        size += value.byteLength;
        totalPayloadBytes += value.byteLength;
        if (size > entry.sizeBytes || totalPayloadBytes > ZIP32_MAX) {
          throw new Error("zip_payload_size_invalid");
        }
        crc = updateCrc(crc, value);
        yield value;
        offset += value.byteLength;
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (size !== entry.sizeBytes) throw new Error("zip_payload_size_mismatch");

    const finalCrc = (crc ^ 0xffff_ffff) >>> 0;
    const descriptor = dataDescriptor(finalCrc, size);
    yield descriptor;
    offset += descriptor.byteLength;
    centralEntries.push({
      name,
      size,
      crc: finalCrc,
      localOffset,
    });
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of centralEntries) {
    const header = centralDirectoryHeader(entry);
    centralSize += header.byteLength;
    yield header;
    offset += header.byteLength;
  }
  if (centralSize > ZIP32_MAX || centralOffset > ZIP32_MAX) {
    throw new Error("zip_archive_size_invalid");
  }
  yield endOfCentralDirectory(
    centralEntries.length,
    centralSize,
    centralOffset,
  );
}

export function zipStoredArchiveContentLength(
  entries: readonly ZipStreamEntry[],
): number {
  validateEntries(entries);
  return (
    entries.reduce((total, entry) => {
      const nameBytes = new TextEncoder().encode(entry.name).byteLength;
      return total + entry.sizeBytes + 30 + nameBytes + 16 + 46 + nameBytes;
    }, 0) + 22
  );
}
