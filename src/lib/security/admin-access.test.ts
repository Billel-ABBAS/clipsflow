import { describe, expect, it } from "vitest";

import { hasAdminAccess } from "./admin-access";

describe("hasAdminAccess", () => {
  it("autorise uniquement le compte explicitement promu", () => {
    expect(
      hasAdminAccess({
        email: "abbas.billel1985@gmail.com",
        app_metadata: { app_role: "admin" },
      }),
    ).toBe(true);
  });

  it("ignore les rôles placés dans les métadonnées modifiables du profil", () => {
    expect(
      hasAdminAccess({
        email: "abbas.billel1985@gmail.com",
        app_metadata: {},
        user_metadata: { app_role: "admin", role: "admin" },
      }),
    ).toBe(false);
  });

  it("n'accorde pas l'accès admin à un autre compte", () => {
    expect(
      hasAdminAccess({
        email: "other@example.com",
        app_metadata: { app_role: "admin" },
      }),
    ).toBe(false);
  });
});
