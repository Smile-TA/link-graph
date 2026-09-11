/**
 * The liveness probe (PRD §3.1): DNS resolves → serves HTTP → carries the platform
 * signature (Apache/2.4.68 + CloudFront headers) → `/version.txt` present.
 *
 * DNS and HTTP are both injected (engineering guide §4.3) so unit tests run a fake
 * resolver and fetcher — a registry-health decision must be testable without a live
 * host, the same reason `packages/truth`'s HTTP fetch is a `deps` parameter.
 */
export interface DnsResult {
  readonly ok: boolean;
}

export interface HttpProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface LivenessDeps {
  resolveDns(host: string): Promise<DnsResult>;
  fetchUrl(url: string): Promise<HttpProbeResult>;
}

export interface LivenessResult {
  readonly checkedAt: Date;
  readonly dnsOk: boolean;
  readonly serves: boolean;
  readonly platformSig: boolean;
  /** The body of `/version.txt` when it served 2xx, else `null`. */
  readonly versionTxt: string | null;
}

/**
 * The platform signature PRD §3.1 names: an `Apache/2.4.68`-flavoured `Server` header
 * plus a CloudFront header. Checked as two independent signals rather than one regex
 * over the whole header blob, so a host fronted by CloudFront but not this Apache build
 * (or vice versa) is visibly "half-signed" to anyone reading the two booleans back out
 * of a failing test, rather than a single opaque `false`.
 */
export function hasPlatformSignature(headers: Readonly<Record<string, string>>): boolean {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const server = lower.get("server") ?? "";
  const hasApache = /Apache\/2\.4\.68/i.test(server);
  const hasCloudFront =
    lower.has("x-amz-cf-id") ||
    lower.has("x-amz-cf-pop") ||
    /cloudfront/i.test(lower.get("via") ?? "");
  return hasApache && hasCloudFront;
}

/**
 * One probe of one host. Never throws: a DNS or fetch failure is a `false` in the
 * result, because "the host is dead" is the fact this function exists to report, not
 * an error the caller has to catch (engineering guide §1 — a probe that throws on the
 * dead-host case is a probe that cannot be run over an estate with any).
 */
export async function probeLiveness(
  host: string,
  deps: LivenessDeps,
  now: () => Date = () => new Date(),
): Promise<LivenessResult> {
  const checkedAt = now();
  const dns = await safely(() => deps.resolveDns(host));
  if (!dns.ok) {
    return {
      checkedAt,
      dnsOk: false,
      serves: false,
      platformSig: false,
      versionTxt: null,
    };
  }

  const rootProbe = await safely(() => deps.fetchUrl(`https://${host}/`));
  const serves = rootProbe.ok && rootProbe.status !== null && rootProbe.status < 500;
  const platformSig = serves && hasPlatformSignature(rootProbe.headers);

  const versionProbe = await safely(() => deps.fetchUrl(`https://${host}/version.txt`));
  const versionTxt =
    versionProbe.ok && versionProbe.status === 200 ? (versionProbe.body ?? "") : null;

  return { checkedAt, dnsOk: true, serves, platformSig, versionTxt };
}

async function safely<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return { ok: false } as T;
  }
}
