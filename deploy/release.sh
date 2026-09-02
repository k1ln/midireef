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
install -m755 deploy/bin/midireef-net '$PI_DIR/bin/midireef-net'
sudo systemctl stop midireef-server
install -m755 server/target/release/midireef-server '$PI_DIR/bin/midireef-server'
sudo systemctl start midireef-server
REMOTE

ok "Release deployed. Kiosk lädt sich selbst neu."
