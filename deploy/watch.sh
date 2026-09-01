#!/usr/bin/env bash
# Watch-Loop: bei jedem Speichern das Passende neu deployen.
#
# Server- und UI-Änderungen werden getrennt behandelt — eine Änderung an einer
# .tsx-Datei soll keinen 20-Sekunden-Rust-Build auslösen und umgekehrt.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v watchexec >/dev/null || die "watchexec fehlt:  brew install watchexec"
require_pi

log "Watch läuft — server/src, shared/ → Server;  ui/src, ui/index.html → UI"
log "Beenden mit Ctrl-C"

watchexec --watch server/src --watch server/Cargo.toml --watch shared \
          --debounce 300ms --restart -- deploy/dev.sh server &
SERVER_PID=$!

watchexec --watch ui/src --watch ui/index.html --watch shared \
          --debounce 300ms --restart -- deploy/dev.sh ui &
UI_PID=$!

trap 'kill $SERVER_PID $UI_PID 2>/dev/null' EXIT INT TERM
wait
