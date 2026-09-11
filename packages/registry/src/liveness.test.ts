import { describe, expect, it } from "vitest";
import { hasPlatformSignature, probeLiveness, type LivenessDeps } from "./liveness.js";

const NOW = new Date("2026-09-11T00:00:00Z");

describe("hasPlatformSignature", () => {
  it("true with the Apache build and a CloudFront header (PRD §3.1)", () => {
    expect(
      hasPlatformSignature({
        Server: "Apache/2.4.68 (Amazon)",
        "X-Amz-Cf-Id": "abc123",
      }),
    ).toBe(true);
  });

  it("false with only the Apache header", () => {
    expect(hasPlatformSignature({ Server: "Apache/2.4.68 (Amazon)" })).toBe(false);
  });

  it("false with only CloudFront and a different server build", () => {
    expect(hasPlatformSignature({ Server: "nginx/1.25", "X-Amz-Cf-Id": "abc123" })).toBe(
      false,
    );
  });

  it("is case-insensitive on header names", () => {
    expect(
      hasPlatformSignature({ server: "Apache/2.4.68", "x-amz-cf-pop": "IAD79-C1" }),
    ).toBe(true);
  });
});

function fakeDeps(over: Partial<LivenessDeps>): LivenessDeps {
  return {
    resolveDns: () => Promise.resolve({ ok: true }),
    fetchUrl: () => Promise.resolve({ ok: true, status: 200, headers: {}, body: "" }),
    ...over,
  };
}

describe("probeLiveness", () => {
  it("dns fails: everything else false, no fetch attempted", async () => {
    let fetched = false;
    const deps = fakeDeps({
      resolveDns: () => Promise.resolve({ ok: false }),
      fetchUrl: () => {
        fetched = true;
        return Promise.resolve({ ok: true, status: 200, headers: {}, body: "" });
      },
    });
    const result = await probeLiveness("agents.integrity.com", deps, () => NOW);
    expect(result).toEqual({
      checkedAt: NOW,
      dnsOk: false,
      serves: false,
      platformSig: false,
      versionTxt: null,
    });
    expect(fetched).toBe(false);
  });

  it("dns ok, connection refused: serves false, platformSig false", async () => {
    const deps = fakeDeps({
      fetchUrl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const result = await probeLiveness("integritymedicarehelpline.com", deps, () => NOW);
    expect(result.dnsOk).toBe(true);
    expect(result.serves).toBe(false);
    expect(result.platformSig).toBe(false);
    expect(result.versionTxt).toBeNull();
  });

  it("serves, but no platform signature: platformSig false, versionTxt still read", async () => {
    const deps = fakeDeps({
      fetchUrl: (url: string) =>
        Promise.resolve(
          url.endsWith("/version.txt")
            ? { ok: true, status: 200, headers: {}, body: "v1.2.6\n" }
            : { ok: true, status: 200, headers: { Server: "nginx" }, body: "<html/>" },
        ),
    });
    const result = await probeLiveness("thirdparty.example.com", deps, () => NOW);
    expect(result.serves).toBe(true);
    expect(result.platformSig).toBe(false);
    expect(result.versionTxt).toBe("v1.2.6\n");
  });

  it("full platform signature and a 404 on /version.txt: versionTxt null, serves true", async () => {
    const deps = fakeDeps({
      fetchUrl: (url: string) =>
        Promise.resolve(
          url.endsWith("/version.txt")
            ? { ok: true, status: 404, headers: {}, body: "Not Found" }
            : {
                ok: true,
                status: 200,
                headers: { Server: "Apache/2.4.68", "X-Amz-Cf-Id": "x" },
                body: "<html/>",
              },
        ),
    });
    const result = await probeLiveness("integrity.com", deps, () => NOW);
    expect(result.serves).toBe(true);
    expect(result.platformSig).toBe(true);
    expect(result.versionTxt).toBeNull();
  });

  it("a 5xx root response is not 'serves'", async () => {
    const deps = fakeDeps({
      fetchUrl: () => Promise.resolve({ ok: true, status: 503, headers: {}, body: "" }),
    });
    const result = await probeLiveness("throttled.example.com", deps, () => NOW);
    expect(result.serves).toBe(false);
  });
});
