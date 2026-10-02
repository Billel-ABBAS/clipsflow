import { describe, expect, it } from "vitest";

import { hasAdminAccess } from "./admin-access";

describe("hasAdminAccess", () => {
  it("autorise uniquement le compte explicitement promu", () => {
    expect(
      hasAdminAccess({
        app_metadata: { app_role: "admin" },
      }),
    ).toBe(true);
  });

  it("ignore les rôles placés dans les métadonnées modifiables du profil", () => {
    expect(
      hasAdminAccess({
        app_metadata: {},
        user_metadata: { app_role: "admin", role: "admin" },
      }),
    ).toBe(false);
  });

  it("refuse l'accès sans rôle serveur même si un email est présent", () => {
    expect(hasAdminAccess({ user_metadata: { role: "admin" } })).toBe(false);
  });
});
