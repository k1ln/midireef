#!/usr/bin/env bash
# Gemeinsame Basis aller Deploy-Skripte: Config laden, Helfer, hübsche Logs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f deploy/config.env ]]; then
  echo "FEHLER: deploy/config.env fehlt." >&2
  echo "  cp deploy/config.env.example deploy/config.env  # und Pi-Daten eintragen" >&2
  exit 1
fi
# shellcheck disable=SC1091
source deploy/config.env

PI="${PI_USER}@${PI_HOST}"

# ControlMaster: eine SSH-Verbindung wird offen gehalten und von allen
# folgenden Aufrufen wiederverwendet. Ohne das kostet jeder der vielen kleinen
# ssh/rsync-Aufrufe im Watch-Loop einen kompletten Handshake (~300 ms).
SSH_CTL="${TMPDIR:-/tmp}/midireef-ssh-%r@%h:%p"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$SSH_CTL" -o ControlPersist=300
          -o ConnectTimeout=5 -o BatchMode=yes)

pi_ssh()  { ssh "${SSH_OPTS[@]}" "$PI" "$@"; }
pi_rsync() { rsync -e "ssh ${SSH_OPTS[*]}" "$@"; }

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

require_pi() {
  pi_ssh true 2>/dev/null || die "Keine SSH-Verbindung zu $PI. Erreichbar? Key hinterlegt?"
}
