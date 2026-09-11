/**
 * The coverage-drift report (step 9 item 5): two classes of mismatch between the
 * registry and reality, neither of which the registry alone or the probe alone can
 * see.
 *
 * - **Deployed but unmonitored** — the site is registered and its latest probe is
 *   live, but `enabled` is `false` so nothing crawls it. The curation overlay
 *   deliberately parks new migrations here (PRD §3.1) until they are ready.
 * - **Configured but dead** — the site is registered and `enabled`, but its latest
 *   probe failed liveness. PRD §3.1's two named examples: `agents.integrity.com` has
 *   no DNS, `integritymedicarehelpline.com` refuses connections.
 *
 * Pure over already-fetched rows, so the classification itself has no I/O to fake in a
 * test — the same shape as `packages/analyse`'s orphan set difference.
 */
export interface DriftSite {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly enabled: boolean;
}

export interface DriftProbe {
  readonly dnsOk: boolean;
  readonly serves: boolean;
  readonly platformSig: boolean;
}

/** `"live"` requires all three probe signals — a partial signature is not liveness. */
function isLive(probe: DriftProbe | null): boolean {
  return probe !== null && probe.dnsOk && probe.serves && probe.platformSig;
}

export interface CoverageDrift {
  readonly deployedButUnmonitored: readonly DriftSite[];
  readonly configuredButDead: readonly DriftSite[];
}

/**
 * `latestProbe` is a lookup rather than a second array, because a site can have zero
 * probes (never checked yet) — treated as neither drift class, since "unmonitored" and
 * "dead" are both claims about a probe result this function does not have.
 */
export function classifyDrift(
  sites: readonly DriftSite[],
  latestProbe: (siteId: string) => DriftProbe | null,
): CoverageDrift {
  const deployedButUnmonitored: DriftSite[] = [];
  const configuredButDead: DriftSite[] = [];
  for (const site of sites) {
    const probe = latestProbe(site.siteId);
    if (probe === null) continue;
    if (!site.enabled && isLive(probe)) deployedButUnmonitored.push(site);
    if (site.enabled && !isLive(probe)) configuredButDead.push(site);
  }
  return { deployedButUnmonitored, configuredButDead };
}
