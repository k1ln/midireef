#!/usr/bin/env bash
# Öffnet eine interaktive SSH-Shell auf dem Pi — direkt im Projektverzeichnis.
#
#   deploy/shell.sh            → landet in $PI_DIR
#   deploy/shell.sh <cmd...>   → führt <cmd> in $PI_DIR aus und kehrt zurück
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi

if (( $# )); then
  # Einzelbefehl im Projektordner ausführen.
  pi_ssh -t "cd '$PI_DIR' && $*"
else
  # Interaktive Login-Shell, Startverzeichnis = Projektordner.
  pi_ssh -t "cd '$PI_DIR' && exec \$SHELL -l"
fi
