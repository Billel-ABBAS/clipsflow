const DEFAULT_ANALYSIS_REQUEST_TIMEOUT_MS = 10_000;

type AbortablePromiseLike<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
};

/** Bound a worker RPC and abort PostgREST requests when the transport supports it. */
export async function withAnalysisRequestTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs = DEFAULT_ANALYSIS_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const request = operation as AbortablePromiseLike<T>;
  const abortable =
    typeof request.abortSignal === "function"
      ? request.abortSignal(controller.signal)
      : operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("analysis_request_timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(abortable), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Add a real network abort to provider/Storage fetches. Supabase Storage's
 * createSignedUrl API does not expose PostgREST's abortSignal helper, so a
 * Promise.race around its SDK promise alone would leave the HTTP request alive.
 */
export function createAbortableAnalysisFetch(
  timeoutMs = DEFAULT_ANALYSIS_REQUEST_TIMEOUT_MS,
  fetchImplementation: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const upstreamSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    };
    const abortFromUpstream = (): void => {
      controller.abort(upstreamSignal?.reason);
      cleanup();
    };

    if (upstreamSignal?.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal?.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("analysis_fetch_timeout"));
      }, timeoutMs);
      timer.unref?.();
    }

    try {
      const response = await fetchImplementation(input, {
        ...init,
        signal: controller.signal,
      });

      // The Supabase Storage client parses this JSON before resolving
      // createSignedUrl. Keep the deadline active through body consumption,
      // not just until response headers arrive.
      for (const method of [
        "arrayBuffer",
        "blob",
        "formData",
        "json",
        "text",
      ] as const) {
        const consume = response[method].bind(response);
        Object.defineProperty(response, method, {
          configurable: true,
          value: async () => {
            try {
              return await consume();
            } catch (error) {
              if (timedOut) throw new Error("analysis_fetch_timeout");
              throw error;
            } finally {
              cleanup();
            }
          },
        });
      }
      if (!response.body) cleanup();
      return response;
    } catch (error) {
      cleanup();
      if (timedOut) throw new Error("analysis_fetch_timeout");
      throw error;
    }
  };
}
