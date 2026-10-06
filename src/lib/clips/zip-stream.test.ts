import { describe, expect, it } from "vitest";

import {
  streamStoredZipEntries,
  zipStoredArchiveContentLength,
} from "./zip-stream";

async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const result: Buffer[] = [];
  for await (const chunk of chunks) result.push(Buffer.from(chunk));
  return Buffer.concat(result);
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("streaming ZIP archive", () => {
  it("writes local entries, data descriptors, a central directory, and exact length", async () => {
    const entries = [
      {
        name: "short-01.mp4",
        sizeBytes: 3,
        open: async () => byteStream(Buffer.from("one")),
      },
      {
        name: "short-02.mp4",
        sizeBytes: 3,
        open: async () => byteStream(Buffer.from("two")),
      },
    ];
    const archive = await collect(streamStoredZipEntries(entries));
    expect(archive.readUInt32LE(0)).toBe(0x0403_4b50);
    expect(archive.includes(Buffer.from("short-01.mp4"))).toBe(true);
    expect(archive.includes(Buffer.from("one"))).toBe(true);
    expect(archive.includes(Buffer.from("two"))).toBe(true);
    expect(archive.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
    expect(archive.readUInt32LE(archive.byteLength - 22)).toBe(0x0605_4b50);
    expect(zipStoredArchiveContentLength(entries)).toBe(archive.byteLength);
  });

  it("rejects mismatched stream sizes and unsafe archive names", async () => {
    await expect(
      collect(
        streamStoredZipEntries([
          {
            name: "short.mp4",
            sizeBytes: 4,
            open: async () => byteStream(Buffer.from("one")),
          },
        ]),
      ),
    ).rejects.toThrow("zip_payload_size_mismatch");
    expect(() =>
      zipStoredArchiveContentLength([
        {
          name: "../secret.mp4",
          sizeBytes: 0,
          open: async () => byteStream(new Uint8Array()),
        },
      ]),
    ).toThrow("zip_entry_invalid");
  });

  it("cancels a stalled upstream body instead of waiting forever", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const iterator = streamStoredZipEntries([
      {
        name: "short.mp4",
        sizeBytes: 1,
        readTimeoutMs: 10,
        open: async () => stalled,
      },
    ]);

    await iterator.next(); // local ZIP header
    await expect(iterator.next()).rejects.toThrow("zip_read_timeout");
    expect(cancelled).toBe(true);
  });
});
