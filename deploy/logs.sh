#!/usr/bin/env bash
# Logs und Dienstzustand vom Pi.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_pi

if [[ "${1:-}" == "--status" ]]; then
  pi_ssh "systemctl --no-pager --lines=0 status midireef-server; \
          systemctl --user --no-pager --lines=0 status midireef-kiosk" || true
else
  log "journalctl -f (Ctrl-C beendet)"
  pi_ssh -t "journalctl -u midireef-server -f -n 50 --output=cat"
fi
