import { describe, expect, it } from "vitest";
import { withRetry, type FetchResult } from "./fetcher.js";

const ok: FetchResult = { kind: "response", status: 200, headers: {}, body: "x" };
const err = (detail: string): FetchResult => ({ kind: "transport-error", detail });

const script = (results: FetchResult[]) => {
  const calls: string[] = [];
  const get = (url: string): Promise<FetchResult> => {
    calls.push(url);
    return Promise.resolve(results.shift() ?? ok);
  };
  return { get, calls };
};
const noSleep = (): Promise<void> => Promise.resolve();

describe("withRetry", () => {
  it("retries a transient resolver failure and returns the later answer", async () => {
    const { get, calls } = script([err("getaddrinfo EAI_AGAIN a.com: EAI_AGAIN"), ok]);
    expect(await withRetry(get, "https://a.com/", noSleep, [1, 1])).toEqual(ok);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the delays are spent and returns the last error", async () => {
    const e = err("Headers Timeout Error: UND_ERR_HEADERS_TIMEOUT");
    const { get, calls } = script([e, e, e, e]);
    expect(await withRetry(get, "https://a.com/", noSleep, [1, 1])).toEqual(e);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a host with no DNS record", async () => {
    const { get, calls } = script([err("getaddrinfo ENOTFOUND a.com: ENOTFOUND")]);
    await withRetry(get, "https://a.com/", noSleep, [1, 1]);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a response, including a 503", async () => {
    const r: FetchResult = { kind: "response", status: 503, headers: {}, body: "" };
    const { get, calls } = script([r]);
    expect(await withRetry(get, "https://a.com/", noSleep, [1, 1])).toEqual(r);
    expect(calls).toHaveLength(1);
  });
});
