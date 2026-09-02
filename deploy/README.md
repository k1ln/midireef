# Deployment auf den Raspberry Pi

Entwickelt wird auf dem Mac, laufen tut es auf einem Pi 5 mit Touchdisplay:
Chromium im Vollbild-Kiosk, der Rust-Server als `systemd`-Dienst, MIDI über ALSA.

---

## Grundaufbau

```
Mac (Entwicklung)                          Pi 5 (Betrieb)
─────────────────                          ──────────────
server/src ──┐                             systemd: midireef-server
             ├─ Docker (arm64, nativ) ──►    ├─ :8787/ws     ← WebSocket
             │                                └─ :8787/*      ← gebautes UI
ui/src ──────┴─ vite build ───────────►    systemd --user: midireef-kiosk
                                              └─ Chromium --kiosk localhost:8787
```

Der Rust-Server bedient **beides** auf einem Port: `/ws` und die statischen
UI-Dateien aus `MIDIREEF_UI_DIR` (Default `./ui`). Damit gibt es keinen zweiten
Webserver und keinen Port-Mismatch — der Kiosk zeigt einfach `localhost:8787`.

### Warum die UI sich selbst neu lädt

Ein Kiosk hat keine Tastatur — ein `F5` ist nicht drin. Deshalb schickt der
Server beim Verbinden `server.hello` mit der Build-Kennung aus `ui/.build-id`.
`net.ts` reconnected nach einem Dienst-Neustart ohnehin von selbst (1 s) und
vergleicht dabei die Kennung mit der, die beim Laden der Seite galt: bei
Abweichung `location.reload()`. Ein Deploy genügt also — Chromium bleibt stehen,
die Seite kommt neu. Im Vite-Dev-Betrieb bleibt die Kennung `dev`, dort macht HMR
das Nachladen ohne Reload.

---

## Ersteinrichtung

**1. Zugangsdaten eintragen**

```bash
cp deploy/config.env.example deploy/config.env
$EDITOR deploy/config.env          # PI_HOST, PI_USER, PI_DIR
```

**2. SSH-Key auf den Pi** (sonst fragt jeder Deploy nach dem Passwort):

```bash
ssh-copy-id pi@midireef.local
```

**3. Pi einrichten** — Pakete, Dienste, Autostart, Bildschirm-Blanking aus:

```bash
make setup
```

**4. Erstes Deploy:**

```bash
make dev          # Docker muss laufen
# oder ohne Docker, dafür langsamer beim ersten Mal:
make deploy
```

### Voraussetzungen

| Wo  | Was | Wofür |
|-----|-----|-------|
| Mac | Docker Desktop | arm64-Build des Servers (`make dev`) |
| Mac | `brew install watchexec` | `make watch` |
| Pi  | Raspberry Pi OS 64-bit (Bookworm) | gleiche glibc wie das Build-Image |
| Pi  | passwortloses `sudo` | Dienst-Neustart im Deploy (Pi-OS-Standard) |
| Pi  | Lesezugriff auf den Git-Remote | nur für `make deploy` (Deploy-Key) |

> **Kein Cross-Compile-Toolchain.** Auf Apple Silicon läuft ein
> `linux/arm64`-Container nativ in der Docker-VM — kein QEMU, volle
> Geschwindigkeit. Das Build-Image ist Debian Bookworm, genau wie Pi OS 64-bit,
> also passt die glibc. Das erspart den üblichen Ärger mit `alsa-sys` und
> `pkg-config` beim echten Cross-Compilieren.

---

## Die drei Arbeitsweisen

### `make hmr` — UI-Arbeit, sofort sichtbar

Der schnellste Loop, wenn du am Frontend baust. Vite läuft auf dem **Mac**, der
Kiosk lädt die Seite von dort, der WebSocket zeigt aber weiter auf den **Pi** —
die echte MIDI-Hardware bleibt also im Spiel.

```bash
make hmr        # Ctrl-C schaltet den Kiosk zurück auf Normalbetrieb
```

Änderung an einer `.tsx` → **~100 ms** bis sie auf dem Display steht, ohne Build,
ohne Deploy, mit erhaltenem UI-Zustand. Möglich macht das der `?ws=`-Parameter
(`net.ts`), der die Server-Adresse von der Herkunft der Seite entkoppelt.

Nur für UI. Rust-Änderungen brauchen weiterhin `make server`.

### `make watch` — alles automatisch bei jedem Speichern

```bash
make watch
```

Zwei getrennte Watcher, damit eine `.tsx`-Änderung keinen Rust-Build auslöst:

| Geändert | Reaktion | Dauer |
|---|---|---|
| `server/src`, `shared` | arm64-Build → rsync → Dienst-Neustart | ~10–30 s inkrementell |
| `ui/src`, `ui/index.html` | `vite build` → rsync → Reload | ~5–8 s |

Beide Wege starten den Server neu — genau das löst den Selbst-Reload aus. Der
Transport steht dabei kurz still; wenn du am Frontend baust, während Musik
läuft, ist `make hmr` der richtige Modus.

### `make deploy` / `make push` — Release

Der Pi zieht den **gepushten** Stand aus Git und baut nativ mit `--release`:

```bash
make deploy     # aus dem bereits gepushten Stand
make push       # git push + Deploy in einem
```

Bewusst anders als der Dev-Pfad: das Artefakt entsteht aus einem committeten,
nachvollziehbaren Stand — nicht aus deinem Arbeitsverzeichnis — und optimiert.
Das ist der Stand, den du laufen lässt, wenn du den Pi allein lässt.

**Automatisch bei jedem Push:**

```bash
git config core.hooksPath .githooks
```

Danach deployt jeder `git push` auf `main` von selbst.
Überspringen mit `git push --no-verify` oder `MIDIREEF_NO_DEPLOY=1 git push`.

---

## Empfehlung

- **Am Frontend?** `make hmr` und im Browser des Macs mitschauen.
- **Am Server?** `make watch` laufen lassen und einfach speichern.
- **Fertig / Pi bleibt allein?** `make push`.

---

## WLAN-Access-Point

Der Pi kann sein eigenes WLAN aufspannen — praktisch, wenn kein Netz da ist und
man trotzdem per Handy/Laptop an die UI will. Bedient wird das **in der UI**
(Einstellungen → „Wi-Fi access point"), nicht per Skript: WLAN-Name + Passwort
eintippen, „Apply". Läuft der AP, zeigt die Karte die Adresse
`http://10.42.0.1:8787` und einen QR-Code zum Beitreten. Das Passwort gilt fürs
WLAN; die App selbst hat keins.

Was `make setup` dafür einrichtet:

| Was | Wofür |
|-----|-------|
| Paket `network-manager` | treibt den AP (`nmcli`, `ipv4.method shared` → DHCP + NAT) |
| `$PI_DIR/bin/midireef-net` | der einzige Befehl, den der Server als root ausführen darf — schreibt die NM-Verbindung `midireef-ap` |
| `/etc/sudoers.d/midireef-net` | erlaubt genau diesem Skript passwortloses `sudo` (mit `visudo -cf` geprüft) |

Annahmen & Grenzen:

- **Schnittstelle `wlan0`.** Andere per `MIDIREEF_AP_IFACE` in der
  `midireef-server.service`-Umgebung überschreiben.
- **Ein Radio.** AP an ⇒ der Pi ist in keinem anderen WLAN mehr. Ein
  **Ethernet**-Uplink bleibt und wird an die AP-Clients weitergereicht (die
  haben dann auch Internet).
- Der Soll-Zustand liegt in `$PI_DIR/data/network.json`; beim Server-Start wird
  er re-appliziert, der AP übersteht also Reboots.
- Prüfen, dass der Dienst-Benutzer den Helfer aufrufen darf:
  `make shell`, dann `sudo -n ~/midireef/bin/midireef-net status`.

---

## Betrieb

```bash
make logs            # Server-Log live
make status          # Zustand beider Dienste
make kiosk-restart   # Chromium neu starten
make shell           # SSH auf den Pi
```

### Fehlersuche

**Kiosk bleibt schwarz.** `kiosk.sh` wartet bis zu 60 s auf Compositor *und*
Server. Danach: `journalctl --user -u midireef-kiosk -n 50`.

**Warum der Kiosk an `default.target` hängt, nicht an `graphical-session.target`.**
Das wäre die naheliegende Wahl, funktioniert auf Pi OS aber nicht: labwc
aktiviert `graphical-session.target` im User-Manager nicht — der Dienst wäre
beim Booten nie gestartet worden. `default.target` läuft dank
`loginctl enable-linger` schon vor jedem Login, und auf den Compositor wartet
`kiosk.sh` ohnehin selbst. Prüfen mit
`systemctl --user is-active graphical-session.target` (steht dort `inactive`,
ist das der Grund).

**Kein MIDI-Gerät.** `make shell`, dann `aconnect -l`. Der Server rescannt die
Eingänge alle 2 s (Hotplug), ein Neustart ist also nicht nötig.

**Chromium zeigt „Wiederherstellen?“.** Sollte `kiosk.sh` beim Start selbst
wegräumen; falls nicht, `rm -rf ~/.cache/midireef-chromium` auf dem Pi.

**Ruckelnde Hintergrundszene.** GPU-Rendering prüfen: im Kiosk `chrome://gpu` ist
ohne Tastatur nicht erreichbar, daher stattdessen mit
`make kiosk-url URL=http://localhost:8787` kurz eine normale Seite laden — oder die
Qualitätsstufe der Pixi-Szene senken (siehe `ui/src/scene/underwater.ts`).

**Deploy hängt bei `sudo`.** Der Pi-Benutzer braucht passwortloses `sudo`
(Pi-OS-Standard für `pi`). Prüfen mit `ssh pi@… sudo -n true`.
