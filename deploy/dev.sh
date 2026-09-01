#!/usr/bin/env bash
# Schneller Dev-Deploy aus dem Arbeitsverzeichnis — ohne Git, ohne Commit.
#
#   deploy/dev.sh                # Server + UI
#   deploy/dev.sh server|ui      # nur eins davon
#   deploy/dev.sh --native       # Server auf dem Pi bauen statt in Docker
#
# Der Server wird normalerweise in einem arm64-Container auf dem Mac gebaut
# (schnell, siehe deploy/Dockerfile.build). Läuft Docker nicht, wird die Quelle
# auf den Pi gespiegelt und dort gebaut — langsamer, aber ohne Voraussetzungen.
# Das UI baut immer der Mac; `vite build` dauert dort Sekunden.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WHAT=all
NATIVE="${MIDIREEF_NATIVE:-0}"
for arg in "$@"; do
  case "$arg" in
    --native)          NATIVE=1 ;;
    all|server|ui)     WHAT="$arg" ;;
    *)                 die "Unbekanntes Argument: $arg (all|server|ui|--native)" ;;
  esac
done

require_pi

# Ohne Docker ist der native Pi-Build der einzige Weg — automatisch umschalten,
# statt mit einem Fehler abzubrechen.
if [[ "$WHAT" != ui && "$NATIVE" != 1 ]] && ! docker info >/dev/null 2>&1; then
  warn "Docker läuft nicht — Server wird stattdessen auf dem Pi gebaut."
  NATIVE=1
fi

build_server_native() {
  log "Quelle → $PI (nativer Build)"
  pi_ssh "mkdir -p '$PI_DIR/build'"
  pi_rsync -a --delete -q \
    --exclude 'target/' --exclude 'target-pi/' \
    server/ "$PI:$PI_DIR/build/server/"
  pi_rsync -a --delete -q shared/ "$PI:$PI_DIR/build/shared/"

  log "Server bauen auf dem Pi …"
  pi_ssh "export PATH=\$HOME/.cargo/bin:\$PATH && \
          cargo build --manifest-path '$PI_DIR/build/server/Cargo.toml' && \
          cp '$PI_DIR/build/server/target/debug/midireef-server' '$PI_DIR/bin/midireef-server.new'"
}

build_server_docker() {
  deploy/build-server.sh debug
  log "Binary → $PI"
  # Nicht direkt überschreiben: systemd hält das laufende Binary offen. Erst
  # nach dem Stop wird .new atomar an seinen Platz geschoben.
  pi_rsync -a -q server/target-pi/debug/midireef-server \
    "$PI:$PI_DIR/bin/midireef-server.new"
}

if [[ "$WHAT" == all || "$WHAT" == server ]]; then
  # Bewusst if/else statt `&& … || …`: bei einem Fehlschlag des nativen Builds
  # würde die ||-Kette sonst zusätzlich den Docker-Build anwerfen.
  if [[ "$NATIVE" == 1 ]]; then
    build_server_native
  else
    build_server_docker
  fi
fi

if [[ "$WHAT" == all || "$WHAT" == ui ]]; then
  log "UI bauen (vite build)"
  ( cd ui && npm run build )
  echo "$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date +%s)" > ui/dist/.build-id
  log "UI → $PI"
  pi_rsync -a --delete -q ui/dist/ "$PI:$PI_DIR/ui/"
fi

log "Dienst neu starten"
pi_ssh "sudo systemctl stop midireef-server; \
        if [ -f '$PI_DIR/bin/midireef-server.new' ]; then \
          mv '$PI_DIR/bin/midireef-server.new' '$PI_DIR/bin/midireef-server'; \
          chmod +x '$PI_DIR/bin/midireef-server'; \
        fi; \
        sudo systemctl start midireef-server"

# Kein Chromium-Neustart nötig: die UI reconnected (net.ts) und lädt sich
# selbst neu, sobald der Server eine neue Build-Kennung meldet.
ok "Deployed. Kiosk lädt sich selbst neu."
