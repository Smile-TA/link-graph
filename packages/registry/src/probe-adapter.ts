/**
 * The real `LivenessDeps`: Node's DNS resolver and `undici`'s fetch, both wrapped so a
 * refused connection or an NXDOMAIN becomes `{ ok: false }` rather than a thrown error
 * — `probeLiveness` in `liveness.ts` already treats a throw as "unreachable", but
 * keeping the mapping here means the pure function never has to know what a DNS module
 * or a fetch client throws.
 */
import { resolve4, resolve6 } from "node:dns/promises";
import { fetch } from "undici";
import type { DnsResult, HttpProbeResult, LivenessDeps } from "./liveness.js";

async function resolveDns(host: string): Promise<DnsResult> {
  try {
    await resolve4(host);
    return { ok: true };
  } catch {
    try {
      await resolve6(host);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}

async function fetchUrl(url: string): Promise<HttpProbeResult> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text().catch(() => null);
  return { ok: true, status: response.status, headers, body };
}

export function createProbeDeps(): LivenessDeps {
  return { resolveDns, fetchUrl };
}
