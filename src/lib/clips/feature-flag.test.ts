// ============================================================================
// Tests unitaires — feature-flag.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  parseClipsFlag,
  isClipsFlagEnabled,
  isClipsEnabledFor,
} from "./feature-flag";

// ---------------------------------------------------------------------------
// parseClipsFlag — parsing
// ---------------------------------------------------------------------------
describe("parseClipsFlag — none", () => {
  it("undefined → none", () => {
    expect(parseClipsFlag(undefined)).toEqual({ kind: "none" });
  });

  it("null → none", () => {
    expect(parseClipsFlag(null)).toEqual({ kind: "none" });
  });

  it("chaîne vide → none", () => {
    expect(parseClipsFlag("")).toEqual({ kind: "none" });
  });

  it("chaîne d'espaces → none", () => {
    expect(parseClipsFlag("  ")).toEqual({ kind: "none" });
  });

  it("'none' → none", () => {
    expect(parseClipsFlag("none")).toEqual({ kind: "none" });
  });
});

describe("parseClipsFlag — all", () => {
  it("'all' → all", () => {
    expect(parseClipsFlag("all")).toEqual({ kind: "all" });
  });
});

describe("parseClipsFlag — locales CSV", () => {
  it("'fr' → locales ['fr']", () => {
    expect(parseClipsFlag("fr")).toEqual({ kind: "locales", locales: ["fr"] });
  });

  it("'fr,en' → locales ['fr', 'en']", () => {
    expect(parseClipsFlag("fr,en")).toEqual({
      kind: "locales",
      locales: ["fr", "en"],
    });
  });

  it("'fr, en' (avec espace) → locales ['fr', 'en']", () => {
    expect(parseClipsFlag("fr, en")).toEqual({
      kind: "locales",
      locales: ["fr", "en"],
    });
  });

  it("'pt-BR' → locales ['pt-BR']", () => {
    expect(parseClipsFlag("pt-BR")).toEqual({
      kind: "locales",
      locales: ["pt-BR"],
    });
  });
});

describe("parseClipsFlag — user IDs", () => {
  const uuid1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const uuid2 = "11111111-2222-3333-4444-555555555555";

  it("'user:<uuid>' → user kind avec 1 ID", () => {
    expect(parseClipsFlag(`user:${uuid1}`)).toEqual({
      kind: "user",
      userIds: [uuid1],
    });
  });

  it("'user:a,user:b' → user kind avec 2 IDs", () => {
    expect(parseClipsFlag(`user:${uuid1},user:${uuid2}`)).toEqual({
      kind: "user",
      userIds: [uuid1, uuid2],
    });
  });

  it("'user:' (vide) → none (pas d'ID extractable)", () => {
    const result = parseClipsFlag("user:");
    expect(result.kind).toBe("none");
  });
});

describe("parseClipsFlag — garbage / mixte → none", () => {
  it("mélange locale + user → none (fail-closed)", () => {
    expect(parseClipsFlag("fr,user:abc")).toEqual({ kind: "none" });
  });

  it("token avec caractères invalides → none", () => {
    // Les tokens locales doivent être [A-Za-z-]+ seulement
    expect(parseClipsFlag("fr_BE")).toEqual({ kind: "none" });
  });

  it("tokens avec chiffres → none (pas un locale valide)", () => {
    expect(parseClipsFlag("123")).toEqual({ kind: "none" });
  });

  it("garbage complet → none", () => {
    expect(parseClipsFlag("!!!garbage!!!")).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// isClipsFlagEnabled
// ---------------------------------------------------------------------------
describe("isClipsFlagEnabled", () => {
  it("kind=none → toujours false", () => {
    expect(isClipsFlagEnabled({ kind: "none" }, {})).toBe(false);
    expect(
      isClipsFlagEnabled({ kind: "none" }, { locale: "fr", userId: "abc" }),
    ).toBe(false);
  });

  it("kind=all → toujours true", () => {
    expect(isClipsFlagEnabled({ kind: "all" }, {})).toBe(true);
    expect(
      isClipsFlagEnabled({ kind: "all" }, { locale: "de", userId: "xyz" }),
    ).toBe(true);
  });

  it("kind=locales → true si locale dans la liste", () => {
    const flag = { kind: "locales" as const, locales: ["fr", "en"] };
    expect(isClipsFlagEnabled(flag, { locale: "fr" })).toBe(true);
    expect(isClipsFlagEnabled(flag, { locale: "en" })).toBe(true);
  });

  it("kind=locales → false si locale absente", () => {
    const flag = { kind: "locales" as const, locales: ["fr"] };
    expect(isClipsFlagEnabled(flag, { locale: "de" })).toBe(false);
  });

  it("kind=locales → false si locale undefined", () => {
    const flag = { kind: "locales" as const, locales: ["fr"] };
    expect(isClipsFlagEnabled(flag, {})).toBe(false);
  });

  it("kind=user → true si userId dans la liste", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const flag = { kind: "user" as const, userIds: [uuid] };
    expect(isClipsFlagEnabled(flag, { userId: uuid })).toBe(true);
  });

  it("kind=user → false si userId absent de la liste", () => {
    const flag = {
      kind: "user" as const,
      userIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    };
    expect(
      isClipsFlagEnabled(flag, {
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBe(false);
  });

  it("kind=user → false si userId undefined", () => {
    const flag = { kind: "user" as const, userIds: ["abc"] };
    expect(isClipsFlagEnabled(flag, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isClipsEnabledFor — wrapper
// ---------------------------------------------------------------------------
describe("isClipsEnabledFor", () => {
  it("flagValue='none' → false pour tout", () => {
    expect(
      isClipsEnabledFor({ flagValue: "none", locale: "fr", userId: "abc" }),
    ).toBe(false);
  });

  it("flagValue='all' → true pour tout", () => {
    expect(isClipsEnabledFor({ flagValue: "all" })).toBe(true);
  });

  it("flagValue='fr' + locale='fr' → true", () => {
    expect(isClipsEnabledFor({ flagValue: "fr", locale: "fr" })).toBe(true);
  });

  it("flagValue='fr' + locale='en' → false", () => {
    expect(isClipsEnabledFor({ flagValue: "fr", locale: "en" })).toBe(false);
  });

  it("flagValue undefined → false (fail-closed en production)", () => {
    // Note : en test NODE_ENV peut être 'test', pas 'production'.
    // On teste directement isClipsEnabledFor (qui ne lit pas NODE_ENV)
    expect(isClipsEnabledFor({ flagValue: undefined })).toBe(false);
  });
});
