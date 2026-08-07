import { describe, expect, it } from "vitest";

import { cn } from "./utils";

// Test fumée de l'infra Vitest (alias @, TS, environment node).
// Les vrais tests métier arrivent avec la Phase 1 (règle : aucune feature sans test).
describe("cn", () => {
  it("fusionne les classes conditionnelles", () => {
    expect(cn("px-2", false && "hidden", "py-1")).toBe("px-2 py-1");
  });

  it("déduplique les conflits Tailwind (dernier gagne)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
