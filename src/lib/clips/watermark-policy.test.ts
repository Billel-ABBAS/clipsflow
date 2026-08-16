import { describe, expect, it, vi } from "vitest";
import { applyPlanWatermark } from "./watermark-policy";

describe("applyPlanWatermark", () => {
  it("applique le watermark au plan gratuit", async () => {
    const input = Buffer.from("plain");
    const output = Buffer.from("watermarked");
    const apply = vi.fn().mockResolvedValue(output);

    await expect(applyPlanWatermark("free", input, apply)).resolves.toBe(
      output,
    );
    expect(apply).toHaveBeenCalledWith(input);
  });

  it("échoue fermé et préfixe l'erreur si le watermark gratuit échoue", async () => {
    const apply = vi.fn().mockRejectedValue(new Error("ffmpeg detail"));

    await expect(
      applyPlanWatermark("free", Buffer.from("plain"), apply),
    ).rejects.toThrow("watermark_failed:");
  });

  it.each(["solo", "pro", "studio"])(
    "ne modifie pas le rendu du plan payant %s",
    async (plan) => {
      const input = Buffer.from("paid");
      const apply = vi.fn();

      await expect(applyPlanWatermark(plan, input, apply)).resolves.toBe(input);
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("traite un plan inconnu comme gratuit", async () => {
    const apply = vi.fn().mockResolvedValue(Buffer.from("watermarked"));
    await applyPlanWatermark("legacy", Buffer.from("plain"), apply);
    expect(apply).toHaveBeenCalledOnce();
  });
});
