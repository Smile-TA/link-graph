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
  /** Non-null when `sync.ts` found this site redirecting to a different host. */
  readonly redirectTargetHost: string | null;
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

export interface DriftAlias {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly redirectTargetHost: string;
}

export interface CoverageDrift {
  readonly deployedButUnmonitored: readonly DriftSite[];
  readonly configuredButDead: readonly DriftSite[];
  /**
   * Redirect aliases (docs/notes.md item 1): `sync.ts` disables these itself, so
   * without a separate bucket they would land in `deployedButUnmonitored` — live but
   * disabled — and read as an unreviewed migration parked by curation rather than what
   * they actually are, a hostname that isn't independently hosting anything.
   */
  readonly redirectAliases: readonly DriftAlias[];
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
  const redirectAliases: DriftAlias[] = [];
  for (const site of sites) {
    if (site.redirectTargetHost !== null) {
      redirectAliases.push({
        siteId: site.siteId,
        canonicalHost: site.canonicalHost,
        redirectTargetHost: site.redirectTargetHost,
      });
      continue;
    }
    const probe = latestProbe(site.siteId);
    if (probe === null) continue;
    if (!site.enabled && isLive(probe)) deployedButUnmonitored.push(site);
    if (site.enabled && !isLive(probe)) configuredButDead.push(site);
  }
  return { deployedButUnmonitored, configuredButDead, redirectAliases };
}
