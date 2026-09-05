#!/usr/bin/env bash
# Einmalige Einrichtung des Raspberry Pi. Idempotent — erneutes Ausführen
# aktualisiert nur die Dienste.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi
log "Richte $PI ein …"

# --- Pakete ---------------------------------------------------------------
# network-manager: treibt den WLAN-Access-Point (Einstellungen → „Wi-Fi access
# point"). Auf Bookworm i.d.R. schon da; mitinstallieren schadet nicht.
log "Pakete installieren (chromium, alsa, network-manager, git …)"
pi_ssh "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium-browser libasound2 alsa-utils network-manager curl rsync git nodejs npm wlr-randr \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium libasound2 alsa-utils network-manager curl rsync git nodejs npm wlr-randr"

# --- Verzeichnisse --------------------------------------------------------
pi_ssh "mkdir -p '$PI_DIR'/bin '$PI_DIR'/ui '$PI_DIR'/data/projects \
        \$HOME/.config/midireef \$HOME/.config/systemd/user"

# --- Git-Checkout für den Release-Pfad ------------------------------------
# `make deploy` baut auf dem Pi aus diesem Checkout — der Dev-Pfad braucht ihn
# nicht (der rsynct nur Artefakte).
ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url "$GIT_REMOTE" 2>/dev/null || true)"
if [[ -n "$ORIGIN_URL" ]]; then
  pi_ssh "test -d '$PI_DIR/src/.git' \
     || git clone --branch '$GIT_BRANCH' '$ORIGIN_URL' '$PI_DIR/src'" \
    && ok "Git-Checkout unter $PI_DIR/src" \
    || warn "Klonen fehlgeschlagen — der Pi braucht Lesezugriff auf $ORIGIN_URL (Deploy-Key). Der Dev-Pfad (make dev) läuft auch ohne."
else
  warn "Kein Git-Remote '$GIT_REMOTE' — nur der Dev-Pfad ist nutzbar."
fi

# --- Rust auf dem Pi (nur für native Release-Builds) ----------------------
if ! pi_ssh "test -x \$HOME/.cargo/bin/cargo"; then
  log "Rust-Toolchain auf dem Pi installieren (für native Release-Builds) …"
  pi_ssh "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path"
  pi_ssh "sudo apt-get install -y -qq libasound2-dev pkg-config build-essential"
fi

# --- Skripte + Dienste ----------------------------------------------------
log "Kiosk-Skript, WLAN-Helfer und systemd-Units installieren"
pi_rsync -a deploy/kiosk.sh "$PI:$PI_DIR/bin/kiosk.sh"
pi_rsync -a deploy/bin/midireef-net "$PI:$PI_DIR/bin/midireef-net"
pi_ssh "chmod +x '$PI_DIR/bin/kiosk.sh' '$PI_DIR/bin/midireef-net'"

render() {  # Platzhalter der Unit-Templates füllen
  sed -e "s|__PI_DIR__|$PI_DIR|g" \
      -e "s|__PI_USER__|$PI_USER|g" \
      -e "s|__MIDIREEF_PORT__|$MIDIREEF_PORT|g" "$1"
}

render deploy/systemd/midireef-server.service \
  | pi_ssh "cat | sudo tee /etc/systemd/system/midireef-server.service >/dev/null"
render deploy/systemd/midireef-kiosk.service \
  | pi_ssh "cat > \$HOME/.config/systemd/user/midireef-kiosk.service"

# sudoers-Zeile: der Server (läuft als $PI_USER) darf NUR den WLAN-Helfer als
# root und ohne Passwort aufrufen. In eine Temp-Datei rendern, mit `visudo -cf`
# prüfen, erst dann nach /etc/sudoers.d verschieben — eine kaputte sudoers-Datei
# sperrt sonst jedes `sudo` auf dem Pi aus.
log "sudoers-Regel für den WLAN-Helfer installieren"
render deploy/systemd/midireef-net.sudoers | pi_ssh "
  set -e
  tmp=\$(mktemp)
  cat > \"\$tmp\"
  chmod 440 \"\$tmp\"
  if sudo visudo -cf \"\$tmp\"; then
    sudo install -m 440 -o root -g root \"\$tmp\" /etc/sudoers.d/midireef-net
    echo '  installiert: /etc/sudoers.d/midireef-net'
  else
    echo '  FEHLER: sudoers-Datei ungültig — nicht installiert' >&2
  fi
  rm -f \"\$tmp\"
" || warn "sudoers-Regel nicht installiert — der WLAN-Schalter bleibt wirkungslos"

# Standard-Ziel des Kiosk: der Rust-Server, der auch das gebaute UI ausliefert.
pi_ssh "echo 'http://localhost:$MIDIREEF_PORT' > \$HOME/.config/midireef/kiosk-url"

pi_ssh "sudo systemctl daemon-reload && sudo systemctl enable midireef-server"
pi_ssh "systemctl --user daemon-reload && systemctl --user enable midireef-kiosk"

# Ohne Linger startet der User-Dienst nur bei einem echten Login — auf einem
# Kiosk-Pi ohne Auto-Login wäre das nie der Fall.
pi_ssh "sudo loginctl enable-linger '$PI_USER'" || true

# --- Display-Verhalten ----------------------------------------------------
log "Bildschirm-Blanking abschalten"
pi_ssh "sudo raspi-config nonint do_blanking 1" 2>/dev/null \
  || warn "raspi-config nicht verfügbar — Blanking ggf. manuell abschalten"

# --- Touch als Touch ausliefern -------------------------------------------
# Pi OS setzt für das Touchdisplay standardmässig mouseEmulation="yes". labwc
# wandelt dann JEDE Berührung in Maus-Events um, bevor sie den Browser
# erreichen: Tippen funktioniert (Mausklick), aber Wischen scrollt nicht und
# Mehrfinger-Gesten gibt es überhaupt nicht — Chromium sieht nie einen
# TouchEvent. Ausserdem klebt ein Mauszeiger auf dem Kiosk.
#
# Nachgemessen mit einem Event-Mitschnitt in der Seite: vorher ausschliesslich
# `pointerdown type=mouse`, danach `touchstart n=1` wie erwartet.
log "Touch-Eingabe: Maus-Emulation abschalten"
pi_ssh 'RC="$HOME/.config/labwc/rc.xml"
        if [ -f "$RC" ] && grep -q "mouseEmulation=\"yes\"" "$RC"; then
          cp "$RC" "$RC.bak"
          sed -i "s/mouseEmulation=\"yes\"/mouseEmulation=\"no\"/" "$RC"
          # labwc liest rc.xml bei SIGHUP neu — kein Session-Neustart nötig.
          killall -HUP labwc 2>/dev/null || true
          echo "  umgestellt (Original: $RC.bak)"
        else
          echo "  nichts zu tun"
        fi' \
  || warn "labwc-Konfiguration nicht angepasst — Touch bleibt ggf. Maus-emuliert"

ok "Pi eingerichtet. Jetzt: make dev  (schneller Loop)  oder  make deploy  (Release)"
