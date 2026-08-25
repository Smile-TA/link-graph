/**
 * The HTTP adapter against a real socket. No database: this is the one seam that talks
 * to a network, and what it has to get right is the shape of a response and of a failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFetcher } from "./fetcher.js";
import { capture, HOST, serve403bplan } from "./testing/403bplan.js";
import { startFixtureServer, type FixtureServer } from "./testing/fixture-server.js";

let server: FixtureServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("createHttpFetcher", () => {
  it("reads a real response over a real socket without following redirects", async () => {
    server = await startFixtureServer({
      [HOST]: (path) =>
        path === "/moved/"
          ? { status: 301, headers: { location: "/" }, body: "" }
          : serve403bplan(path),
    });
    const fetcher = createHttpFetcher();
    const origin = server.originFor(HOST);
    try {
      const home = await fetcher.get(`${origin}/`);
      expect(home).toMatchObject({ kind: "response", status: 200 });
      if (home.kind !== "response") throw new Error("unreachable");
      expect(home.headers["content-type"]).toBe("text/html; charset=UTF-8");
      // The whole body, byte for byte — this is the input `extractPage` parses.
      expect(home.body).toBe(capture("home.html"));

      // undici installs no redirect interceptor here, and the redirect decision needs
      // the site's alias set, so it belongs to fetch-page.ts and not to this layer.
      const moved = await fetcher.get(`${origin}/moved/`);
      expect(moved).toMatchObject({ kind: "response", status: 301 });
      // A redirect's body is a stub nothing will parse, so it is drained, not buffered.
      if (moved.kind !== "response") throw new Error("unreachable");
      expect(moved.body).toBe("");

      const missing = await fetcher.get(`${origin}/nope/`);
      expect(missing).toMatchObject({ kind: "response", status: 404 });
    } finally {
      await fetcher.close?.();
    }
  });

  it("returns a transport failure as data, with the cause attached", async () => {
    // Port 1 on loopback: nothing listens, and the failure is a connection refusal
    // rather than a status code. `packages/truth` records why the cause matters — the
    // message alone is just "fetch failed", which says nothing about a dead host.
    const fetcher = createHttpFetcher();
    try {
      const result = await fetcher.get("http://127.0.0.1:1/");
      expect(result.kind).toBe("transport-error");
      if (result.kind !== "transport-error") throw new Error("unreachable");
      expect(result.detail).toMatch(/ECONNREFUSED/);
    } finally {
      await fetcher.close?.();
    }
  });
});
