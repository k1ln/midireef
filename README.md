# MidiReef

**A dedicated touchscreen MIDI sequencer and live-performance instrument — no laptop, no DAW, just a small screen and your gear.**

MidiReef turns a Raspberry Pi and a touchscreen into a standalone MIDI box: a pattern sequencer for multiple synths/drum machines at once, a live "dashboard" of touch pads and knobs for whatever you've learned from your own controllers, its own rock-solid MIDI clock, and a quiet underwater scene humming along in the background. You build patterns and mappings once, then play the thing like an instrument — tap a pattern, twist a knob, nothing else on the screen but what you need to touch.

It's built to run 24/7 as an appliance, not a dev tool: boot the Pi, the screen lights up straight into MidiReef, full-screen, no window chrome, no mouse.

---

## What it does

- **Sequencer** — one or more MIDI devices, each with its own lanes, each lane a chain of pattern "blocks" (melody, beat, chord, arpeggio, CC automation, program change, pattern shift). Tap a block to fire it, quantized to the beat or instant, your call per lane.
- **Live dashboard** — MIDI-learn any pad or knob on your own controller and it shows up as a touch control on screen, playable straight from the screen too. "Key links" pass a connected keyboard straight through to a chosen synth, transposed/re-channeled if you like.
- **One MIDI clock, many outputs** — MidiReef is the clock master; every connected device stays in sync, each with its own per-lane swing, humanize, echo and glide.
- **All-lanes overview** — a dense, color-coded view of every lane on every device at once, for when you've got a lot going on and one screenful is what you want.
- **Audio recording & playback** — record a take through a connected audio interface, play it back through the Pi's own output, adjustable playback volume, all from the touchscreen — handy for capturing a jam without hauling out separate recording gear.
- **Wi-Fi access point** — no network available? The Pi can host its own, with a QR code on screen to join it from your phone.
- **Projects** — save, duplicate, rename, reload; each one is a plain JSON file, easy to back up or hand-edit; optional one-tap push to a GitHub repo.
- **Runs itself** — systemd services for the server and the kiosk browser, auto-restart, auto-reconnect, self-reloading UI on update.

## What it isn't

Not a DAW, not a synth, not a step sequencer for one device — it's the layer that sits between your controllers and your gear, sequencing and routing MIDI. You still need the actual sound-making hardware (or software synths on the receiving end) — MidiReef only sends and receives MIDI.

---

## Hardware you'll need

| Part | Notes |
|---|---|
| **Raspberry Pi 5** (4GB or more) | The only Pi this is built and tested for. |
| **Official Raspberry Pi power supply (27W USB-C)** | The Pi 5 is picky about power — a phone charger will brown out under load. |
| **microSD card, 16GB+ (A2-rated recommended)**, or a USB SSD | Raspberry Pi OS + MidiReef fit comfortably; an SSD is snappier and more durable for something that runs constantly. |
| **A landscape touchscreen, ~1280×720** | e.g. the official Raspberry Pi Touch Display 2, or any similar HDMI/DSI touchscreen in that size class. Smaller/bigger panels mostly work too — there's an in-app UI-scale slider — but the layout is tuned for this. |
| **A case with active cooling** | The Pi 5 throttles under sustained load without one. |
| **One or more USB MIDI interfaces/controllers** | Whatever you're already using — class-compliant USB MIDI just works. |
| *Optional:* **USB audio interface** | Only needed for the recording feature. |

No keyboard or mouse needed for normal use — the whole thing is touch-only. You'll want one briefly during setup (or just SSH in from another computer).

---

## Install

SSH into a fresh Raspberry Pi OS (64-bit, Bookworm) install, or open a terminal on it directly, then:

```bash
curl -fsSL https://raw.githubusercontent.com/k1ln/midireef/main/deploy/install.sh | bash
```

That's it — it installs the required packages, builds MidiReef natively for your Pi (a few minutes the first time), sets it up as a service, and configures the kiosk to launch full-screen on boot. Reboot once afterwards so touch input and full-screen kiosk mode both take effect cleanly:

```bash
sudo reboot
```

Never used a Raspberry Pi before, or want the fully-detailed walkthrough (flashing the SD card, first boot, connecting your gear)? See **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

Already have it installed and want to update to the latest version?

```bash
cd ~/midireef/src && git pull && ./deploy/install.sh
```

Your saved projects live in `~/midireef/data/` and are never touched by an update.

---

## First run

1. Plug in your MIDI gear (and audio interface, if you have one) before or after booting — MidiReef rescans for new devices every couple of seconds, no restart needed.
2. On the touchscreen, tap **SQ** (Sequencer) → **＋ Device** → pick a MIDI output port.
3. Add a lane to it, add a block, tap the block to hear it.
4. Tap **DB** (Dashboard) to build a live touch surface, or long-press a knob on your own controller to MIDI-learn it in.
5. Tap the gear icon for project save/load, display and Wi-Fi settings.

More detail on each screen, and a full first-project walkthrough, in **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

---

## Keeping it running

```bash
journalctl -u midireef-server -f          # server log, live
systemctl status midireef-server          # is it running?
systemctl --user status midireef-kiosk    # is the kiosk browser running?
sudo systemctl restart midireef-server    # restart the server (UI reconnects itself)
```

Common snags:

- **Blank/black screen after boot.** Give it up to a minute — the kiosk waits for both the display compositor and the server. If it's still blank, check `journalctl --user -u midireef-kiosk -n 50`.
- **Taps register as clicks but swiping/multi-touch doesn't work.** The installer fixes this (disables Pi OS's default mouse-emulation for touch), but it needs a reboot to fully take effect.
- **No MIDI device showing up.** Class-compliant USB MIDI should appear within a couple of seconds of plugging in — no restart needed. If it never does, check the device is actually class-compliant (needs no vendor driver).
- **No sound out of a recording.** Check the *Output* section of the Audio screen (**RC** in the top bar) — the wrong output device selected is the most common cause, not a broken recording. There's a "Test tone" button there to check the output path on its own.

For anything not covered here, `docs/GETTING_STARTED.md` has a longer troubleshooting section.

---

## Developing MidiReef

The install script above is for *running* MidiReef. If you want to change the code, the project is a Rust server (`server/`, owns MIDI timing/output) talking to a React UI (`ui/`, touch-only frontend) over a WebSocket — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it fits together, and **[deploy/README.md](deploy/README.md)** for the day-to-day dev loop (fast UI hot-reload against a real Pi, watch-and-redeploy, etc.).

## License

No license file yet — until one's added, treat this as "all rights reserved, source visible." If you'd like to use or fork it, open an issue.
