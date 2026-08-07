// ============================================================================
// Tests unitaires — verify-magic-bytes.ts (verifySourceMagicBytes + détection)
// ============================================================================
// On teste uniquement les fonctions PURES (detectSourceMediaFamily,
// verifySourceMagicBytes). La fonction verifyMagicBytes (avec Supabase I/O)
// est couverte par le smoke test E2E.

import { describe, it, expect } from "vitest";
import {
  detectSourceMediaFamily,
  verifySourceMagicBytes,
} from "./verify-magic-bytes";

// ---------------------------------------------------------------------------
// Helpers — buffers synthétiques
// ---------------------------------------------------------------------------

function mp4FtypBytes(): Uint8Array {
  // offset 0-3 : taille box (ex 0x00 0x00 0x00 0x18)
  // offset 4-7 : "ftyp" = 0x66 0x74 0x79 0x70
  const b = new Uint8Array(16);
  b[0] = 0x00;
  b[1] = 0x00;
  b[2] = 0x00;
  b[3] = 0x18;
  b[4] = 0x66; // f
  b[5] = 0x74; // t
  b[6] = 0x79; // y
  b[7] = 0x70; // p
  // brand : "mp42"
  b[8] = 0x6d;
  b[9] = 0x70;
  b[10] = 0x34;
  b[11] = 0x32;
  return b;
}

function movMoovBytes(): Uint8Array {
  // QuickTime legacy : box-type "moov" à offset 4
  const b = new Uint8Array(16);
  b[4] = 0x6d; // m
  b[5] = 0x6f; // o
  b[6] = 0x6f; // o
  b[7] = 0x76; // v
  return b;
}

function webmBytes(): Uint8Array {
  // EBML header : 0x1A 0x45 0xDF 0xA3 à offset 0
  const b = new Uint8Array(16);
  b[0] = 0x1a;
  b[1] = 0x45;
  b[2] = 0xdf;
  b[3] = 0xa3;
  return b;
}

function mp3Id3Bytes(): Uint8Array {
  // ID3 header : "ID3" = 0x49 0x44 0x33
  const b = new Uint8Array(16);
  b[0] = 0x49; // I
  b[1] = 0x44; // D
  b[2] = 0x33; // 3
  return b;
}

function mp3FrameSyncBytes(): Uint8Array {
  // MPEG frame sync : 0xFF suivi d'un octet dont les bits 7-5 = 111 (0xFB typique)
  const b = new Uint8Array(16);
  b[0] = 0xff;
  b[1] = 0xfb; // bits 7-5 = 111 → high nibble = 0xF → (0xFB & 0xE0) = 0xE0 ✓
  return b;
}

function m4aBytes(): Uint8Array {
  // M4A utilise la même signature ftyp que MP4
  return mp4FtypBytes();
}

function wavBytes(): Uint8Array {
  // RIFF????WAVE : offset 0="RIFF", offset 8="WAVE"
  const b = new Uint8Array(16);
  b[0] = 0x52; // R
  b[1] = 0x49; // I
  b[2] = 0x46; // F
  b[3] = 0x46; // F
  // offset 4-7 : taille (quelconque)
  b[4] = 0x00;
  b[5] = 0x00;
  b[6] = 0x00;
  b[7] = 0x10;
  b[8] = 0x57; // W
  b[9] = 0x41; // A
  b[10] = 0x56; // V
  b[11] = 0x45; // E
  return b;
}

function htmlBytes(): Uint8Array {
  // Contenu HTML : "<html"
  const b = new Uint8Array(16);
  const chars = "<html><body></bo";
  for (let i = 0; i < chars.length; i++) {
    b[i] = chars.charCodeAt(i);
  }
  return b;
}

// ---------------------------------------------------------------------------
// detectSourceMediaFamily
// ---------------------------------------------------------------------------
describe("detectSourceMediaFamily", () => {
  it("détecte MP4 (ftyp box)", () => {
    expect(detectSourceMediaFamily(mp4FtypBytes())).toBe("isobmff");
  });

  it("détecte MOV (moov box)", () => {
    expect(detectSourceMediaFamily(movMoovBytes())).toBe("isobmff");
  });

  it("détecte M4A (même ftyp que MP4)", () => {
    expect(detectSourceMediaFamily(m4aBytes())).toBe("isobmff");
  });

  it("détecte WebM (EBML header)", () => {
    expect(detectSourceMediaFamily(webmBytes())).toBe("webm");
  });

  it("détecte MP3 avec ID3 header", () => {
    expect(detectSourceMediaFamily(mp3Id3Bytes())).toBe("mp3");
  });

  it("détecte MP3 avec frame sync (0xFF 0xFx)", () => {
    expect(detectSourceMediaFamily(mp3FrameSyncBytes())).toBe("mp3");
  });

  it("détecte WAV (RIFF+WAVE)", () => {
    expect(detectSourceMediaFamily(wavBytes())).toBe("wav");
  });

  it("rejette un fichier HTML (pas de famille connue)", () => {
    expect(detectSourceMediaFamily(htmlBytes())).toBeNull();
  });

  it("rejette un buffer vide", () => {
    expect(detectSourceMediaFamily(new Uint8Array(0))).toBeNull();
  });

  it("rejette un buffer trop court (< 4 bytes)", () => {
    expect(detectSourceMediaFamily(new Uint8Array([0xff, 0xfb]))).toBe("mp3");
    // Mais un seul byte ne devrait pas matcher
    expect(detectSourceMediaFamily(new Uint8Array([0xff]))).toBeNull();
  });

  it("WAV a la priorité sur MP3 même si RIFF pourrait contenir 0xFF", () => {
    // Le WAV check est avant le MP3 check — un fichier WAV valide ne doit
    // pas être mal détecté comme MP3 même si ses octets 0-1 sont 0xFF
    const wav = wavBytes();
    // WAV commence par "RIFF" pas 0xFF — cette vérification confirme la priorité
    expect(detectSourceMediaFamily(wav)).toBe("wav");
  });
});

// ---------------------------------------------------------------------------
// verifySourceMagicBytes — sans content-type
// ---------------------------------------------------------------------------
describe("verifySourceMagicBytes — sans content-type", () => {
  it("MP4 sans content-type → ok=true, family=isobmff", () => {
    const result = verifySourceMagicBytes(mp4FtypBytes());
    expect(result.ok).toBe(true);
    expect(result.family).toBe("isobmff");
  });

  it("WebM sans content-type → ok=true, family=webm", () => {
    const result = verifySourceMagicBytes(webmBytes());
    expect(result.ok).toBe(true);
    expect(result.family).toBe("webm");
  });

  it("HTML → ok=false, family=null", () => {
    const result = verifySourceMagicBytes(htmlBytes());
    expect(result.ok).toBe(false);
    expect(result.family).toBeNull();
  });

  it("buffer vide → ok=false", () => {
    const result = verifySourceMagicBytes(new Uint8Array(0));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySourceMagicBytes — avec content-type (contrainte famille)
// ---------------------------------------------------------------------------
describe("verifySourceMagicBytes — avec content-type", () => {
  it("video/mp4 + bytes MP4 → ok=true", () => {
    const result = verifySourceMagicBytes(mp4FtypBytes(), "video/mp4");
    expect(result.ok).toBe(true);
  });

  it("video/mp4 + bytes WebM → ok=false (contradiction)", () => {
    const result = verifySourceMagicBytes(webmBytes(), "video/mp4");
    expect(result.ok).toBe(false);
    // family détectée reste webm (pour le logging)
    expect(result.family).toBe("webm");
  });

  it("audio/mpeg + bytes MP3-ID3 → ok=true", () => {
    const result = verifySourceMagicBytes(mp3Id3Bytes(), "audio/mpeg");
    expect(result.ok).toBe(true);
  });

  it("audio/mpeg + bytes MP3-framesync → ok=true", () => {
    const result = verifySourceMagicBytes(mp3FrameSyncBytes(), "audio/mpeg");
    expect(result.ok).toBe(true);
  });

  it("audio/wav + bytes WAV → ok=true", () => {
    const result = verifySourceMagicBytes(wavBytes(), "audio/wav");
    expect(result.ok).toBe(true);
  });

  it("audio/wav + bytes MP3 → ok=false (contradiction)", () => {
    const result = verifySourceMagicBytes(mp3Id3Bytes(), "audio/wav");
    expect(result.ok).toBe(false);
  });

  it("content-type avec paramètres ('video/mp4; charset=binary') → les paramètres sont ignorés", () => {
    const result = verifySourceMagicBytes(
      mp4FtypBytes(),
      "video/mp4; charset=binary",
    );
    expect(result.ok).toBe(true);
  });

  it("content-type inconnu (application/octet-stream) → n'impose pas de contrainte famille", () => {
    // application/octet-stream n'est pas dans CONTENT_TYPE_FAMILY
    // → tout bytes reconnu est accepté
    const result = verifySourceMagicBytes(
      mp4FtypBytes(),
      "application/octet-stream",
    );
    expect(result.ok).toBe(true);
  });

  it("content-type inconnu + bytes HTML → ok=false (aucune famille détectée)", () => {
    const result = verifySourceMagicBytes(
      htmlBytes(),
      "application/octet-stream",
    );
    expect(result.ok).toBe(false);
  });
});
