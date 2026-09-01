#!/usr/bin/env bash
# Schaltet um, was der Kiosk-Browser anzeigt, und startet ihn neu.
#
#   deploy/kiosk-url.sh prod   → Pi-Server liefert das gebaute UI (Normalbetrieb)
#   deploy/kiosk-url.sh hmr    → UI kommt live vom Vite-Dev-Server des Macs,
#                                 WebSocket zeigt weiter auf den Pi
#   deploy/kiosk-url.sh <url>  → beliebige URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="${1:-prod}"
require_pi

case "$MODE" in
  prod) URL="http://localhost:$MIDIREEF_PORT" ;;
  hmr)
    MAC_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
    [[ -n "$MAC_IP" ]] || die "Mac-IP nicht ermittelbar — URL bitte direkt angeben."
    # ws-Parameter: die Seite kommt vom Mac, der WebSocket muss trotzdem zum Pi.
    URL="http://$MAC_IP:$VITE_PORT/?ws=ws://localhost:$MIDIREEF_PORT/ws"
    ;;
  *) URL="$MODE" ;;
esac

pi_ssh "echo '$URL' > \$HOME/.config/midireef/kiosk-url && systemctl --user restart midireef-kiosk"
ok "Kiosk zeigt jetzt: $URL"
