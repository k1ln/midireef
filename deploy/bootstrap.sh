#!/usr/bin/env bash
# Einmalige Einrichtung des Raspberry Pi. Idempotent — erneutes Ausführen
# aktualisiert nur die Dienste.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi
log "Richte $PI ein …"

# --- Pakete ---------------------------------------------------------------
log "Pakete installieren (chromium, alsa, git …)"
pi_ssh "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium-browser libasound2 alsa-utils curl rsync git nodejs npm \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium libasound2 alsa-utils curl rsync git nodejs npm"

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
log "Kiosk-Skript und systemd-Units installieren"
pi_rsync -a deploy/kiosk.sh "$PI:$PI_DIR/bin/kiosk.sh"
pi_ssh "chmod +x '$PI_DIR/bin/kiosk.sh'"

render() {  # Platzhalter der Unit-Templates füllen
  sed -e "s|__PI_DIR__|$PI_DIR|g" \
      -e "s|__PI_USER__|$PI_USER|g" \
      -e "s|__MIDIREEF_PORT__|$MIDIREEF_PORT|g" "$1"
}

render deploy/systemd/midireef-server.service \
  | pi_ssh "cat | sudo tee /etc/systemd/system/midireef-server.service >/dev/null"
render deploy/systemd/midireef-kiosk.service \
  | pi_ssh "cat > \$HOME/.config/systemd/user/midireef-kiosk.service"

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

ok "Pi eingerichtet. Jetzt: make dev  (schneller Loop)  oder  make deploy  (Release)"
