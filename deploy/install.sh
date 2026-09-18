#!/usr/bin/env bash
# MidiReef — one-shot installer. Run this ON the Raspberry Pi itself (no
# companion Mac/PC, no Docker, no SSH config needed — see deploy/README.md
# for that separate developer workflow).
#
# Fresh Pi, nothing cloned yet:
#
#   curl -fsSL https://raw.githubusercontent.com/k1ln/midireef/main/deploy/install.sh | bash
#
# Already have a checkout:
#
#   cd midireef && ./deploy/install.sh
#
# Idempotent — safe to re-run. To update later: `git pull` (or re-run the
# curl one-liner) then run this script again; it rebuilds and restarts the
# service, your saved projects in data/ are untouched.
set -euo pipefail

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Config (override via env, e.g. MIDIREEF_PORT=9000 ./install.sh) ────────
INSTALL_DIR="${MIDIREEF_DIR:-$HOME/midireef}"
REPO_URL="${MIDIREEF_REPO:-https://github.com/k1ln/midireef.git}"
BRANCH="${MIDIREEF_BRANCH:-main}"
PORT="${MIDIREEF_PORT:-8787}"
PI_USER="$(whoami)"

[[ "$(uname -s)" == "Linux" ]] || die "This installs a Linux (Raspberry Pi OS) service — run it on the Pi, not here."
if [[ "$(uname -m)" != "aarch64" ]]; then
  warn "Not running on aarch64 (64-bit) — MidiReef targets Raspberry Pi OS 64-bit (Bookworm). Continuing anyway."
fi

# ── 1. Source checkout ──────────────────────────────────────────────────────
# Running from a real clone (./deploy/install.sh) reuses it in place — nothing
# is overwritten. A curl-piped run (no real script file) clones/updates one at
# $INSTALL_DIR/src instead.
resolve_src_dir() {
  local src="${BASH_SOURCE[0]:-}"
  if [[ -n "$src" && -f "$src" ]]; then
    local dir
    dir="$(cd "$(dirname "$src")/.." && pwd)"
    [[ -f "$dir/server/Cargo.toml" ]] && { echo "$dir"; return; }
  fi
  echo ""
}
SRC_DIR="$(resolve_src_dir)"
if [[ -z "$SRC_DIR" ]]; then
  SRC_DIR="$INSTALL_DIR/src"
  if [[ -d "$SRC_DIR/.git" ]]; then
    log "Updating existing checkout in $SRC_DIR"
    git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
    git -C "$SRC_DIR" checkout --quiet "$BRANCH"
    git -C "$SRC_DIR" reset --hard --quiet "origin/$BRANCH"
  else
    log "Cloning $REPO_URL"
    mkdir -p "$INSTALL_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
  fi
fi
ok "Source: $SRC_DIR"

# ── 2. System packages ───────────────────────────────────────────────────────
log "Installing packages (chromium, ALSA, network-manager, build tools …) — needs sudo"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium-browser libasound2 alsa-utils network-manager curl rsync git nodejs npm wlr-randr \
  build-essential pkg-config libasound2-dev \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  chromium libasound2 alsa-utils network-manager curl rsync git nodejs npm wlr-randr \
  build-essential pkg-config libasound2-dev

mkdir -p "$INSTALL_DIR"/bin "$INSTALL_DIR"/ui "$INSTALL_DIR"/data/projects \
         "$HOME/.config/midireef" "$HOME/.config/systemd/user"

# ── 3. Rust toolchain (native release build happens right here on the Pi) ──
if ! command -v cargo >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  log "Installing Rust (rustup) …"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"

# ── 4. Build ─────────────────────────────────────────────────────────────────
log "Building server (release, native — a few minutes on a fresh Pi 5, be patient)"
cargo build --release --manifest-path "$SRC_DIR/server/Cargo.toml"

log "Building UI"
( cd "$SRC_DIR/ui" && npm ci --no-audit --no-fund && npm run build )
echo "$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo local)-$(date +%s)" > "$SRC_DIR/ui/dist/.build-id"

# ── 5. Install artifacts ────────────────────────────────────────────────────
log "Installing binaries + UI"
rsync -a --delete "$SRC_DIR/ui/dist/" "$INSTALL_DIR/ui/"
install -m755 "$SRC_DIR/deploy/bin/midireef-net" "$INSTALL_DIR/bin/midireef-net"
install -m755 "$SRC_DIR/deploy/bin/midireef-display" "$INSTALL_DIR/bin/midireef-display"
install -m755 "$SRC_DIR/deploy/kiosk.sh" "$INSTALL_DIR/bin/kiosk.sh"
sudo systemctl stop midireef-server 2>/dev/null || true
install -m755 "$SRC_DIR/server/target/release/midireef-server" "$INSTALL_DIR/bin/midireef-server"

# ── 6. systemd units + sudoers rule ─────────────────────────────────────────
log "Installing systemd services"
render() {
  sed -e "s|__PI_DIR__|$INSTALL_DIR|g" -e "s|__PI_USER__|$PI_USER|g" -e "s|__MIDIREEF_PORT__|$PORT|g" "$1"
}
render "$SRC_DIR/deploy/systemd/midireef-server.service" \
  | sudo tee /etc/systemd/system/midireef-server.service >/dev/null
render "$SRC_DIR/deploy/systemd/midireef-kiosk.service" \
  > "$HOME/.config/systemd/user/midireef-kiosk.service"

# Only THIS script may run as root, passwordless — everything else in the
# service runs as $PI_USER. Checked with `visudo -cf` before install; a
# broken sudoers file would lock out every `sudo` on the Pi.
log "Installing the Wi-Fi access point helper's sudoers rule"
TMP_SUDOERS="$(mktemp)"
render "$SRC_DIR/deploy/systemd/midireef-net.sudoers" > "$TMP_SUDOERS"
chmod 440 "$TMP_SUDOERS"
if sudo visudo -cf "$TMP_SUDOERS"; then
  sudo install -m 440 -o root -g root "$TMP_SUDOERS" /etc/sudoers.d/midireef-net
else
  warn "sudoers file invalid — not installed. The in-app Wi-Fi access point switch won't work; everything else is unaffected."
fi
rm -f "$TMP_SUDOERS"

echo "http://localhost:$PORT" > "$HOME/.config/midireef/kiosk-url"

# ── 7. Enable + start ───────────────────────────────────────────────────────
sudo systemctl daemon-reload
sudo systemctl enable --now midireef-server
systemctl --user daemon-reload
systemctl --user enable --now midireef-kiosk
# Without linger the user service only runs during a real login session — on
# a kiosk Pi with auto-login this still needs to survive a plain boot.
sudo loginctl enable-linger "$PI_USER" 2>/dev/null || true

# ── 8. Display behavior ─────────────────────────────────────────────────────
log "Disabling screen blanking"
sudo raspi-config nonint do_blanking 1 2>/dev/null || warn "raspi-config unavailable — disable screen blanking manually if the display sleeps."

# Pi OS defaults the touchscreen to mouse emulation: taps register as clicks,
# but swipes don't scroll and there's no multi-touch — labwc never forwards a
# real TouchEvent to Chromium. Flip it off (rc.xml), no session restart needed
# (labwc reloads rc.xml on SIGHUP).
log "Enabling real touch input (disabling labwc mouse emulation)"
RC="$HOME/.config/labwc/rc.xml"
if [[ -f "$RC" ]] && grep -q 'mouseEmulation="yes"' "$RC"; then
  cp "$RC" "$RC.bak"
  sed -i 's/mouseEmulation="yes"/mouseEmulation="no"/' "$RC"
  killall -HUP labwc 2>/dev/null || true
  ok "Touch input enabled (backup: $RC.bak)"
else
  log "Nothing to change (already off, or no labwc config yet — reboot once and re-run if needed)"
fi

echo
ok "MidiReef installed."
echo "  Open:    http://localhost:$PORT  (also reachable at http://$(hostname).local:$PORT from another device)"
echo "  Logs:    journalctl -u midireef-server -f"
echo "  Status:  systemctl status midireef-server; systemctl --user status midireef-kiosk"
echo "  Update:  cd $SRC_DIR && git pull && ./deploy/install.sh"
echo
echo "  If the touchscreen was still in mouse-emulation mode, reboot once now: sudo reboot"
