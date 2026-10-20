import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAbortableAnalysisFetch,
  withAnalysisRequestTimeout,
} from "./analysis-request";

afterEach(() => {
  vi.useRealTimers();
});

describe("withAnalysisRequestTimeout", () => {
  it("aborts a pending PostgREST request and rejects at the deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = new Promise<never>(() => {}) as Promise<never> & {
      abortSignal: (value: AbortSignal) => Promise<never>;
    };
    pending.abortSignal = (value) => {
      signal = value;
      return pending;
    };

    const result = withAnalysisRequestTimeout(pending, 25);
    const rejection = expect(result).rejects.toThrow(
      "analysis_request_timeout",
    );
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("returns a settled request and clears its timeout", async () => {
    vi.useFakeTimers();
    await expect(
      withAnalysisRequestTimeout(Promise.resolve("ok"), 25),
    ).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(25);
  });
});

describe("createAbortableAnalysisFetch", () => {
  it("aborts the underlying fetch and reports its bounded timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("fetch_aborted")),
            { once: true },
          );
        }),
    );
    const request = createAbortableAnalysisFetch(
      25,
      fetchImplementation as typeof fetch,
    )("https://supabase.example/storage/v1/object/sign/test", {
      method: "POST",
    });
    const rejection = expect(request).rejects.toThrow("analysis_fetch_timeout");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(signal?.aborted).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("preserves caller cancellation", async () => {
    const upstream = new AbortController();
    let signal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("fetch_aborted")),
            { once: true },
          );
        }),
    );
    const request = createAbortableAnalysisFetch(
      10_000,
      fetchImplementation as typeof fetch,
    )("https://supabase.example/storage/v1/object/sign/test", {
      signal: upstream.signal,
    });
    const rejection = expect(request).rejects.toThrow("fetch_aborted");

    upstream.abort();
    await rejection;

    expect(signal?.aborted).toBe(true);
  });

  it("clears the deadline after the Storage JSON body is consumed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ signedURL: "/signed" }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    const response = await createAbortableAnalysisFetch(
      25,
      fetchImplementation as typeof fetch,
    )("https://supabase.example/storage/v1/object/sign/test", {
      method: "POST",
    });

    await expect(response.json()).resolves.toEqual({ signedURL: "/signed" });
    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(false);
  });
});
