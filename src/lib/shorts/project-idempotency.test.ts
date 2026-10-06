import { describe, expect, it, vi } from "vitest";

import {
  releaseShortsProjectIdempotencyIntent,
  resolveShortsProjectIdempotencyIntent,
} from "./project-idempotency";

describe("Shorts project submission idempotency", () => {
  it("reuses a key for the same unresolved request", () => {
    const current = { fingerprint: "same-request", key: "key-1" };
    const createKey = vi.fn(() => "key-2");

    expect(
      resolveShortsProjectIdempotencyIntent(current, "same-request", createKey),
    ).toBe(current);
    expect(createKey).not.toHaveBeenCalled();
  });

  it("releases a failed request so an exact user retry receives a new key", () => {
    const failed = { fingerprint: "same-request", key: "key-1" };
    const released = releaseShortsProjectIdempotencyIntent(failed, "failed");
    const retry = resolveShortsProjectIdempotencyIntent(
      released,
      "same-request",
      () => "key-2",
    );

    expect(released).toBeNull();
    expect(retry).toEqual({ fingerprint: "same-request", key: "key-2" });
  });

  it("releases a completed request before the creator intentionally reruns it", () => {
    const completed = { fingerprint: "same-request", key: "key-1" };
    const released = releaseShortsProjectIdempotencyIntent(completed, "ready");

    expect(
      resolveShortsProjectIdempotencyIntent(
        released,
        "same-request",
        () => "key-2",
      ),
    ).toEqual({ fingerprint: "same-request", key: "key-2" });
  });

  it("preserves pending requests and fails closed if UUID creation is unavailable", () => {
    const pending = { fingerprint: "same-request", key: "key-1" };

    expect(releaseShortsProjectIdempotencyIntent(pending, "analyzing")).toBe(
      pending,
    );
    expect(
      resolveShortsProjectIdempotencyIntent(null, "new-request", () => null),
    ).toBeNull();
  });
});
