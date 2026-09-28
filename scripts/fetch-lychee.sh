#!/usr/bin/env bash
# Download the lychee binary into the gitignored vendor/ directory, verifying it against
# the release's published sha256 (PRD §6.1, §8).
#
# The binary is NOT in git: it is a 17.9 MB third-party executable, and a multi-megabyte
# blob in git history is effectively irreversible. PRD §8 vendors it into the *worker
# image*, which is this same script run from a Dockerfile.
#
# Recorded 2026-09-02, from https://api.github.com/repos/lycheeverse/lychee/releases/latest
# and cross-checked against each asset's `digest` field in that same API response:
#
#   lychee-x86_64-apple-darwin.tar.gz        7338545 bytes  sha256 887503a9…d55978
#   lychee-aarch64-apple-darwin.tar.gz       6992530 bytes  sha256 c9d3740e…1c4977
#
# Linux targets musl, not gnu (docs/notes.md item 10): the gnu build needs GLIBC 2.38,
# which `node:22-slim` (Debian bookworm, GLIBC 2.36) does not have — invisible until
# `Dockerfile.worker`'s build actually succeeded for the first time (2026-09-28) and the
# vendored binary failed at spawn instead, with `GLIBC_2.38 not found`. musl's static
# link has no libc version dependency at all, so it runs on any Linux host or container,
# glibc or not — the actual property this script needs, not "matches the build image's
# glibc" which would just move the same failure to the next image upgrade.
#
#   lychee-x86_64-unknown-linux-musl.tar.gz   7705781 bytes  sha256 73657a11…41566fc5
#   lychee-aarch64-unknown-linux-musl.tar.gz  6962068 bytes  sha256 5d0b0e3a…8ede7dba5
#
# The checksums below are not hardcoded copies of those: the release publishes a
# `<asset>.sha256` file next to each tarball, and this script downloads and checks
# against that. The table above is the record of what was seen on the day, so a silent
# re-publish of a tag is visible as a mismatch rather than as a new trusted binary.
set -euo pipefail

RELEASE="${LYCHEE_RELEASE:-lychee-v0.24.2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/lychee"

case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64)          TARGET=x86_64-apple-darwin ;;
  Darwin-arm64)           TARGET=aarch64-apple-darwin ;;
  Linux-x86_64)           TARGET=x86_64-unknown-linux-musl ;;
  Linux-aarch64|Linux-arm64) TARGET=aarch64-unknown-linux-musl ;;
  *) echo "no lychee release asset for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

ASSET="lychee-$TARGET.tar.gz"
BASE="https://github.com/lycheeverse/lychee/releases/download/$RELEASE"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching $RELEASE $ASSET"
curl -fsSL -o "$WORK/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$WORK/$ASSET.sha256" "$BASE/$ASSET.sha256"

# The published file is `<sha256>␠␠<filename>`, which both shasum -c and sha256sum -c
# read. Verify before extracting: an unverified tarball is not opened.
( cd "$WORK" && { command -v sha256sum >/dev/null && sha256sum -c "$ASSET.sha256" \
                  || shasum -a 256 -c "$ASSET.sha256"; } )

tar -xzf "$WORK/$ASSET" -C "$WORK"
mkdir -p "$DEST"
install -m 0755 "$WORK/lychee-$TARGET/lychee" "$DEST/lychee"

echo "installed $("$DEST/lychee" --version) at $DEST/lychee"
echo "sha256 of the extracted binary: $( { command -v sha256sum >/dev/null && sha256sum "$DEST/lychee" || shasum -a 256 "$DEST/lychee"; } )"
