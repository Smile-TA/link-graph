# certs/

`zscaler-root-ca.pem`: this org's network intercepts and re-signs outbound TLS with
Zscaler's own CA. `Dockerfile.worker` bakes it into the worker image's trust store —
without it, every HTTPS fetch inside the container (`npm ci`, `curl`, the worker's own
runtime crawl/truth-source fetches) fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
which is what was behind the "flaky `npm ci`" build failure (docs/notes.md item 10;
see docs/04-operations.md §1).

A root CA certificate is public by design — this is not a secret. Exported from the
macOS system keychain (`security find-certificate -c "Zscaler Root CA" -p
/Library/Keychains/System.keychain`) on 2026-09-28.

If this repo is ever built on a network without Zscaler in the path, this cert is
simply inert (nothing presents a chain signed by it, so it's just an unused trusted
root) — it does not need to be conditionally applied.
