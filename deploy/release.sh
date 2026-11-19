#!/usr/bin/env bash
# Release-Deploy: der Pi zieht den Stand aus Git und baut nativ.
#
# Bewusst anders als deploy/dev.sh: hier entsteht das Artefakt aus einem
# committeten, nachvollziehbaren Stand — nicht aus dem Arbeitsverzeichnis —
# und mit `--release`-Optimierung, die auf dem Pi tatsächlich zählt.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi

if [[ -n "$(git status --porcelain)" ]]; then
  warn "Arbeitsverzeichnis ist nicht sauber — der Pi baut den gepushten Stand, nicht diesen."
fi

LOCAL_SHA="$(git rev-parse HEAD)"
log "Release $(git rev-parse --short HEAD) → $PI"

pi_ssh bash -euo pipefail <<REMOTE
export PATH="\$HOME/.cargo/bin:\$PATH"
cd '$PI_DIR/src'

git fetch --quiet '$GIT_REMOTE' '$GIT_BRANCH'
git checkout --quiet '$GIT_BRANCH'
git reset --hard --quiet '$GIT_REMOTE/$GIT_BRANCH'

REMOTE_SHA="\$(git rev-parse HEAD)"
if [ "\$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  echo "! Pi steht auf \${REMOTE_SHA:0:7}, lokal ist ${LOCAL_SHA:0:7} — vergessen zu pushen?" >&2
fi

# Netzname des Pi (mDNS): http://<PI_HOSTNAME>.local:<port>. Fehlt das Skript
# (noch nicht gepusht), bleibt alles beim Alten.
if [ -n '${PI_HOSTNAME:-}' ] && [ -f deploy/set-hostname.sh ]; then
  echo "▸ Hostname setzen ($PI_HOSTNAME)"
  bash deploy/set-hostname.sh '${PI_HOSTNAME:-}' || echo "! Hostname konnte nicht gesetzt werden" >&2
fi

echo "▸ Server bauen (release, nativ)"
cargo build --release --manifest-path server/Cargo.toml

echo "▸ UI bauen"
cd ui
# npm ci nur, wenn sich die Abhängigkeiten geändert haben — auf dem Pi kostet
# ein voller Install Minuten, ein reiner Rebuild Sekunden.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "  … Abhängigkeiten installieren"
  npm ci --no-audit --no-fund
fi
npm run build
cd ..
echo "\$(git rev-parse --short HEAD)-\$(date +%s)" > ui/dist/.build-id

echo "▸ Artefakte übernehmen"
rsync -a --delete ui/dist/ '$PI_DIR/ui/'
rsync -a --delete server/midi-library/ '$PI_DIR/midi-library/'
install -m755 deploy/bin/midireef-net '$PI_DIR/bin/midireef-net'
install -m755 deploy/bin/midireef-display '$PI_DIR/bin/midireef-display'
sudo systemctl stop midireef-server
install -m755 server/target/release/midireef-server '$PI_DIR/bin/midireef-server'
sudo systemctl start midireef-server
REMOTE

ok "Release deployed. Kiosk lädt sich selbst neu."

# Wurde der Pi umbenannt, passt `PI_HOST=<alter-name>.local` nicht mehr — ohne
# Nachziehen schlüge schon das nächste Deploy fehl. Nur anfassen, wenn PI_HOST
# ein .local-Name ist (IP oder ~/.ssh/config-Alias bleiben, wie sie sind) und
# der neue Name vom Mac aus wirklich erreichbar ist.
NEW_HOST="${PI_HOSTNAME:-}.local"
if [[ -n "${PI_HOSTNAME:-}" && "$PI_HOST" == *.local && "$PI_HOST" != "$NEW_HOST" ]]; then
  reachable=0
  for _ in 1 2 3 4 5 6 7 8; do
    if ssh "${SSH_OPTS[@]}" -o StrictHostKeyChecking=accept-new "${PI_USER}@${NEW_HOST}" true 2>/dev/null; then reachable=1; break; fi
    sleep 2
  done
  if [[ $reachable == 1 ]]; then
    sed "s|^PI_HOST=.*|PI_HOST=$NEW_HOST|" deploy/config.env > deploy/config.env.tmp && mv deploy/config.env.tmp deploy/config.env
    ok "Pi ist jetzt unter http://$NEW_HOST:${MIDIREEF_PORT:-8787} erreichbar — PI_HOST in deploy/config.env darauf umgestellt."
  else
    warn "$NEW_HOST antwortet (noch) nicht per SSH. Ist der Pi umbenannt, setze PI_HOST=$NEW_HOST in deploy/config.env."
  fi
fi
