import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchTimeoutError, safeFetch } from "./safe-fetch";

const publicAnswers = [{ address: "93.184.216.34", family: 4 }];
const neverLookup = () => new Promise<never>(() => undefined);

describe("safeFetch — délais et annulation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("interrompt l'attente DNS au délai global sans démarrer le fetch", async () => {
    const fetchImpl = vi.fn();
    const rejected = vi.fn();
    void safeFetch("https://cdn.example.com/file", {
      timeoutMs: 50,
      lookup: neverLookup,
      fetchImpl,
    }).catch(rejected);

    await vi.advanceTimersByTimeAsync(50);
    expect(rejected).toHaveBeenCalledWith(expect.any(FetchTimeoutError));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respecte l'annulation de l'appelant pendant le DNS", async () => {
    const controller = new AbortController();
    const reason = new Error("download_cancelled");
    const fetchImpl = vi.fn();
    const rejected = vi.fn();
    void safeFetch("https://cdn.example.com/file", {
      timeoutMs: 500,
      signal: controller.signal,
      lookup: neverLookup,
      fetchImpl,
    }).catch(rejected);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ne lance ni DNS ni fetch si le signal est déjà annulé", async () => {
    const controller = new AbortController();
    const reason = new Error("already_cancelled");
    controller.abort(reason);
    const lookup = vi.fn(async () => publicAnswers);
    const fetchImpl = vi.fn(async () => new Response("unused"));

    await expect(
      safeFetch("https://cdn.example.com/file", {
        signal: controller.signal,
        lookup,
        fetchImpl,
      }),
    ).rejects.toBe(reason);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hérite du signal d'une Request quand init ne le remplace pas", async () => {
    const controller = new AbortController();
    const reason = new Error("request_cancelled");
    const request = new Request("https://cdn.example.com/file", {
      signal: controller.signal,
    });
    controller.abort(reason);
    const lookup = vi.fn(async () => publicAnswers);
    const fetchImpl = vi.fn(async () => new Response("unused"));

    await expect(safeFetch(request, { lookup, fetchImpl })).rejects.toBe(reason);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ne conserve aucun timer après une URL invalide", async () => {
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ne redémarre pas un téléchargement après une résolution DNS tardive", async () => {
    let resolveLookup!: (answers: typeof publicAnswers) => void;
    const lookup = () =>
      new Promise<typeof publicAnswers>((resolve) => {
        resolveLookup = resolve;
      });
    const rejected = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("unused"));
    void safeFetch("https://cdn.example.com/file", {
      timeoutMs: 50,
      lookup,
      fetchImpl,
    }).catch(rejected);

    await vi.advanceTimersByTimeAsync(50);
    resolveLookup(publicAnswers);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(expect.any(FetchTimeoutError));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("laisse le corps réussi à l'appelant après libération du timer", async () => {
    const response = await safeFetch("https://cdn.example.com/file", {
      timeoutMs: 50,
      lookup: async () => publicAnswers,
      fetchImpl: async () => new Response("video-content"),
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(await response.text()).toBe("video-content");
  });
});
