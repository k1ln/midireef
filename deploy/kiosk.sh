#!/usr/bin/env bash
# Startet Chromium im Vollbild-Kiosk auf dem Pi-Touchdisplay.
#
# Läuft als systemd-*User*-Dienst, also ohne die Umgebung einer Login-Shell:
# Compositor-Socket und Ziel-URL werden hier selbst ermittelt und abgewartet.
set -uo pipefail

URL="$(cat "$HOME/.config/midireef/kiosk-url" 2>/dev/null || echo http://localhost:8787)"
PROFILE="$HOME/.cache/midireef-chromium"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# 1) Auf den Compositor warten. Nach einem Reboot startet der User-Dienst
#    leicht vor Wayland/X — ohne dieses Warten stirbt Chromium sofort und
#    landet in der Restart-Schleife.
PLATFORM=""
for _ in $(seq 1 60); do
  if [[ -n "${WAYLAND_DISPLAY:-}" && -S "$XDG_RUNTIME_DIR/${WAYLAND_DISPLAY}" ]]; then
    PLATFORM=wayland; break
  fi
  for sock in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
    [[ -S "$sock" ]] || continue
    export WAYLAND_DISPLAY="$(basename "$sock")"
    PLATFORM=wayland; break 2
  done
  if [[ -n "${DISPLAY:-}" ]] || [[ -e /tmp/.X11-unix/X0 ]]; then
    export DISPLAY="${DISPLAY:-:0}"
    PLATFORM=x11; break
  fi
  sleep 1
done
[[ -n "$PLATFORM" ]] || { echo "kiosk: kein Compositor gefunden" >&2; exit 1; }

# 2) Auf den Server warten — sonst zeigt der Kiosk eine Fehlerseite, die
#    niemand ohne Tastatur wegklicken kann. Nur für http(s): eine URL wie
#    about:blank oder file:// kann curl nicht prüfen und würde die Schleife
#    sinnlos 60×  durchlaufen lassen.
case "$URL" in
  http://*|https://*)
    for _ in $(seq 1 60); do
      curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null && break
      sleep 1
    done
    ;;
esac

# 3) Absturz-Spuren löschen: sonst blendet Chromium beim Start das
#    „Wiederherstellen?“-Banner ein, das ohne Tastatur im Weg bleibt.
if [[ -f "$PROFILE/Default/Preferences" ]]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' \
    "$PROFILE/Default/Preferences" 2>/dev/null || true
fi

# Bildschirmschoner/Blanking aus (X11; unter Wayland macht das der Compositor).
if [[ "$PLATFORM" == x11 ]]; then
  xset s off -dpms s noblank 2>/dev/null || true
fi

# Bildschirmdrehung — umschaltbar in den UI-Einstellungen (display.setRotation).
# Nach einem Reboot, bevor der Server läuft, gilt hier erstmal der zuletzt
# gespeicherte Wert aus der Datei, die der Server bei jeder Umschaltung schreibt.
ROTATION="$(cat "$HOME/.config/midireef/kiosk-rotation" 2>/dev/null || echo 0)"
if [[ "$ROTATION" == "180" ]]; then
  "$(dirname "$0")/midireef-display" 180 2>/dev/null || true
fi

CHROMIUM="$(command -v chromium-browser || command -v chromium)"
[[ -n "$CHROMIUM" ]] || { echo "kiosk: chromium nicht installiert" >&2; exit 1; }

FLAGS=(
  --kiosk "$URL"
  --user-data-dir="$PROFILE"
  --start-fullscreen
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-features=Translate,TranslateUI,AutofillServerCommunication
  --no-first-run
  --no-default-browser-check
  --check-for-update-interval=31536000
  --password-store=basic

  # Touch-Verhalten: die UI ist touch-only (docs/ARCHITECTURE.md §6). Pinch-Zoom
  # und Wisch-Zurück würden Bedienung und Layout kaputtmachen.
  --touch-events=enabled
  --disable-pinch
  --overscroll-history-navigation=0

  # PixiJS-Hintergrundszene soll auf der Pi-GPU laufen, nicht in Software.
  --ignore-gpu-blocklist
  --enable-gpu-rasterization
  --enable-zero-copy
  --canvas-oop-rasterization
)
[[ "$PLATFORM" == wayland ]] && FLAGS+=(--ozone-platform=wayland --enable-features=UseOzonePlatform)

exec "$CHROMIUM" "${FLAGS[@]}"
