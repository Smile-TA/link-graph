import { describe, expect, it } from "vitest";
import { classifyDrift, type DriftProbe, type DriftSite } from "./drift.js";

const LIVE: DriftProbe = { dnsOk: true, serves: true, platformSig: true };
const NO_DNS: DriftProbe = { dnsOk: false, serves: false, platformSig: false };
const REFUSED: DriftProbe = { dnsOk: true, serves: false, platformSig: false };
const NO_SIGNATURE: DriftProbe = { dnsOk: true, serves: true, platformSig: false };

const site = (
  siteId: string,
  enabled: boolean,
  redirectTargetHost: string | null = null,
): DriftSite => ({
  siteId,
  canonicalHost: `${siteId}.example`,
  enabled,
  redirectTargetHost,
});

describe("classifyDrift", () => {
  it("a live but disabled site is deployed-but-unmonitored", () => {
    const drift = classifyDrift([site("new-migration", false)], () => LIVE);
    expect(drift.deployedButUnmonitored.map((s) => s.siteId)).toEqual(["new-migration"]);
    expect(drift.configuredButDead).toEqual([]);
  });

  it("an enabled site with no DNS is configured-but-dead (PRD §3.1's agents.integrity.com)", () => {
    const drift = classifyDrift([site("agents.integrity.com", true)], () => NO_DNS);
    expect(drift.configuredButDead.map((s) => s.siteId)).toEqual([
      "agents.integrity.com",
    ]);
    expect(drift.deployedButUnmonitored).toEqual([]);
  });

  it("an enabled site whose connection is refused is configured-but-dead", () => {
    const drift = classifyDrift(
      [site("integritymedicarehelpline.com", true)],
      () => REFUSED,
    );
    expect(drift.configuredButDead.map((s) => s.siteId)).toEqual([
      "integritymedicarehelpline.com",
    ]);
  });

  it("a partial signature (serves, no platform sig) still counts as dead when enabled", () => {
    const drift = classifyDrift([site("third-party-host", true)], () => NO_SIGNATURE);
    expect(drift.configuredButDead.map((s) => s.siteId)).toEqual(["third-party-host"]);
  });

  it("enabled and fully live: neither bucket", () => {
    const drift = classifyDrift([site("healthy.com", true)], () => LIVE);
    expect(drift.deployedButUnmonitored).toEqual([]);
    expect(drift.configuredButDead).toEqual([]);
  });

  it("disabled and dead: neither bucket — correctly parked, not a finding", () => {
    const drift = classifyDrift([site("wip.com", false)], () => NO_DNS);
    expect(drift.deployedButUnmonitored).toEqual([]);
    expect(drift.configuredButDead).toEqual([]);
  });

  it("no probe at all: neither bucket, never probed yet", () => {
    const drift = classifyDrift([site("never-synced.com", true)], () => null);
    expect(drift.deployedButUnmonitored).toEqual([]);
    expect(drift.configuredButDead).toEqual([]);
  });

  it("a redirect target host is a redirect alias, not deployed-but-unmonitored, even though it's live and disabled", () => {
    const drift = classifyDrift(
      [site("askintegrity.com", false, "integrity.com")],
      () => LIVE,
    );
    expect(drift.redirectAliases).toEqual([
      {
        siteId: "askintegrity.com",
        canonicalHost: "askintegrity.com.example",
        redirectTargetHost: "integrity.com",
      },
    ]);
    expect(drift.deployedButUnmonitored).toEqual([]);
    expect(drift.configuredButDead).toEqual([]);
  });
});
