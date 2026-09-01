#!/usr/bin/env bash
# Baut das Server-Binary für den Pi (aarch64 Linux) im Docker-Container.
# Ergebnis: server/target-pi/<profile>/midireef-server
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROFILE="${1:-debug}"
IMAGE=midireef-build:bookworm-arm64

docker info >/dev/null 2>&1 \
  || die "Docker läuft nicht. Docker Desktop starten — oder \`make deploy\` nutzen (baut nativ auf dem Pi, ohne Docker)."

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "Build-Image wird einmalig erzeugt ($IMAGE) …"
  docker build --platform linux/arm64 -t "$IMAGE" -f deploy/Dockerfile.build deploy/
fi

# Eigenes target-Verzeichnis: der Mac-Build in server/target bleibt unberührt,
# sonst würde jeder Wechsel Mac↔Pi das halbe Crate neu übersetzen.
# Registry + git-Checkouts liegen in benannten Volumes und überleben Läufe.
CARGO_FLAGS=(build)
[[ "$PROFILE" == "release" ]] && CARGO_FLAGS+=(--release)

log "Server-Build für aarch64-linux ($PROFILE) …"
docker run --rm --platform linux/arm64 \
  -v "$REPO_ROOT/server:/build" \
  -v midireef-cargo-registry:/usr/local/cargo/registry \
  -v midireef-cargo-git:/usr/local/cargo/git \
  -e CARGO_TARGET_DIR=/build/target-pi \
  "$IMAGE" cargo "${CARGO_FLAGS[@]}"

BIN="server/target-pi/$PROFILE/midireef-server"
[[ -f "$BIN" ]] || die "Binary nicht gefunden: $BIN"
ok "$BIN ($(du -h "$BIN" | cut -f1))"
