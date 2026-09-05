#!/usr/bin/env bash
# Dreht die Kiosk-Anzeige und startet Chromium neu.
#
#   deploy/kiosk-rotate.sh 180  → auf den Kopf (Standard, Display sitzt verkehrt im Gehäuse)
#   deploy/kiosk-rotate.sh 0    → normal
#   deploy/kiosk-rotate.sh 90   → quer, im Uhrzeigersinn
#   deploy/kiosk-rotate.sh 270  → quer, gegen den Uhrzeigersinn
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROTATION="${1:?Nutzung: deploy/kiosk-rotate.sh 0|90|180|270}"
case "$ROTATION" in
  0|90|180|270) ;;
  *) die "Ungültige Drehung: $ROTATION (erlaubt: 0, 90, 180, 270)" ;;
esac

require_pi
pi_ssh "echo '$ROTATION' > \$HOME/.config/midireef/kiosk-rotation && systemctl --user restart midireef-kiosk"
ok "Kiosk-Anzeige gedreht: ${ROTATION}°"
