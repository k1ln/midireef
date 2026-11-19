#!/usr/bin/env bash
# Setzt den Hostnamen des Pi, damit er im Netz unter <name>.local (mDNS/Avahi)
# erreichbar ist: http://<name>.local:8787
#
# Läuft AUF dem Pi (aufgerufen von install.sh und release.sh), idempotent: ist
# der Name schon gesetzt, passiert nichts. Aufruf: set-hostname.sh <name>
#
# Gibt bei einer echten Umbenennung "RENAMED <alt> <neu>" aus — Grundlage dafür,
# dass release.sh danach PI_HOST in deploy/config.env nachzieht.
set -euo pipefail

name="${1:-}"
# Ein DNS-Label: Kleinbuchstaben, Ziffern, Bindestrich; nicht an den Enden.
if [[ ! "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "set-hostname: ungültiger Hostname '$name' (nur a-z, 0-9 und '-', max. 63 Zeichen)" >&2
  exit 1
fi

# Ohne Avahi gäbe es den .local-Namen gar nicht (Pi OS bringt es mit, ein
# Lite-/Minimal-Image evtl. nicht).
if ! command -v avahi-daemon >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq avahi-daemon
fi

current="$(hostname)"
if [[ "$current" == "$name" ]]; then
  echo "Hostname ist schon '$name' — http://$name.local"
  exit 0
fi

sudo hostnamectl set-hostname "$name"

# /etc/hosts: sudo und einige Dienste lösen den eigenen Namen über 127.0.1.1
# auf — bleibt dort der alte Name stehen, meckert jedes `sudo` ("unable to
# resolve host").
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sudo sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$name/" /etc/hosts
else
  printf '127.0.1.1\t%s\n' "$name" | sudo tee -a /etc/hosts >/dev/null
fi

# Avahi kündigt den neuen Namen erst nach einem Neustart des Dienstes an.
sudo systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
sudo systemctl restart avahi-daemon

echo "RENAMED $current $name"
echo "Hostname: $current → $name — erreichbar unter http://$name.local"
