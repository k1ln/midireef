# Getting started with MidiReef

A from-scratch walkthrough: turning a bare Raspberry Pi into a running MidiReef box, then building your first sequence. If you've set up a Pi before and just want the install command, the [README](../README.md) has the short version — this doc is the one with no steps skipped.

## 1. What you'll need

| Part | Notes |
|---|---|
| Raspberry Pi 5 (4GB+) | This is what MidiReef is built and tested for. |
| Official 27W USB-C power supply | Don't substitute a phone charger — the Pi 5 needs real power under load. |
| microSD card (16GB+, A2-rated) or USB SSD | Either works; an SSD is more durable for something left running all the time. |
| A landscape touchscreen, ~1280×720 | e.g. the official Raspberry Pi Touch Display 2. See the [official assembly guide](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html) for physically connecting whichever screen you have — that part is screen-specific and best covered by its own manual. |
| A case with active cooling | The Pi 5 throttles hard without one. |
| USB MIDI interface(s)/controller(s) | Whatever you already have — class-compliant USB MIDI needs no drivers. |
| *(Optional)* USB audio interface | Only if you want the recording feature. |
| A computer to flash the SD card from | Mac, Windows or Linux, just for the one-time setup step below. |
| A keyboard, or another computer on the same network | To run one install command. You won't need either again after this. |

## 2. Flash Raspberry Pi OS

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your computer.
2. Insert the SD card, open Imager, choose **Raspberry Pi 5** as the device and **Raspberry Pi OS (64-bit)** as the OS — the full desktop version, not Lite (MidiReef's kiosk needs the desktop compositor).
3. Click the gear icon (⚙) / "Edit settings" before writing:
   - Set a hostname (e.g. `midireef`) — this is how you'll reach it afterwards (`midireef.local`).
   - Enable SSH, set a username/password.
   - If you're not connecting the Pi to Ethernet, enter your Wi-Fi network here too.
4. Write the image, then move the card (or plug the SSD) into the Pi.

## 3. First boot

Connect the touchscreen and power on. Give it a minute or two for the first boot.

From your computer, on the same network:

```bash
ssh <username>@<hostname>.local
```

(using the hostname and username you set in step 2). If `.local` doesn't resolve on your network, find the Pi's IP address from your router's device list instead.

## 4. Install MidiReef

Once you're connected:

```bash
curl -fsSL https://raw.githubusercontent.com/k1ln/midireef/main/deploy/install.sh | bash
```

This installs the required system packages, builds MidiReef directly on the Pi (the first build takes a few minutes — subsequent updates are much faster), sets up the two background services (the MIDI server and the kiosk browser), and fixes the touchscreen's input mode. You'll be asked for your password once or twice (for `sudo`).

When it finishes:

```bash
sudo reboot
```

The Pi should come back up straight into MidiReef, full-screen on the touchscreen. You won't need SSH again for normal use — only for updates or troubleshooting.

## 5. Connect your gear

Plug your MIDI interface(s) into the Pi's USB ports (directly, or through a powered hub if you have several). MidiReef rescans for MIDI devices every couple of seconds, so there's no restart needed — plug in, and it shows up.

If you have a USB audio interface for recording, plug that in too.

## 6. Your first sequence

On the touchscreen:

1. Tap **SQ** in the top bar (Sequencer).
2. Tap **＋ Device** in the top bar, pick your MIDI output port from the list. This adds a device panel.
3. Tap the device's settings (tap its name) → **＋ Add lane**, pick a lane type (e.g. "melody").
4. The new lane starts with one demo block — tap the block's lower half to trigger it. If your synth is set to listen on the right MIDI channel, you'll hear it play.
5. Tap the block's upper half to select it, then open it (long-press, or use the dock that appears) to edit the actual notes.
6. Hit the ▶ transport button (top-left) to start the clock — blocks quantized to the beat will now wait for the downbeat instead of firing instantly.

That's the core loop: devices → lanes → blocks, each block a short pattern you can tap to fire, live or quantized.

### Live dashboard

Tap **DB** in the top bar. Long-press anywhere empty to enter MIDI-learn, then move a knob or hit a pad on your own controller — it appears as a touch control on screen, and you can play it from the screen exactly the same as from the hardware. Useful for controls you want playable even when your hardware controller isn't within reach.

### Saving your work

Tap the gear icon (⚙) → your project is listed under "Currently open"; tap **Save**. Projects are plain JSON files in `~/midireef/data/projects/` on the Pi — easy to back up, copy elsewhere, or version-control yourself.

## 7. Optional: Wi-Fi access point mode

If there's no network available where you're performing, the Pi can host its own. In Settings (⚙) → "Wi-Fi access point", set a network name and password, tap **Apply**. The screen then shows a QR code and the address (`http://10.42.0.1:8787`) to join from a phone or laptop — useful for controlling MidiReef remotely from another device, or just checking on it.

Note: the Pi only has one Wi-Fi radio, so turning the access point on drops any Wi-Fi network it was previously connected to (an Ethernet connection, if you have one plugged in, keeps working and is shared to AP clients).

## 8. Optional: recording

Tap **RC** in the top bar for the Audio screen. Pick your input and output devices under Settings on the right, hit record from the ⏺ button in the transport bar, and your take appears in the Recordings list on the left — tap ▶ to play it back through the Pi's own output, or download it over Wi-Fi.

If you don't hear anything on playback, use the **Test tone** button first — it isolates whether the problem is the output routing (usually: wrong device selected, or the Pi's own audio output when you meant your interface) versus the recording itself.

---

## Troubleshooting

**Screen stays black after boot.** The kiosk waits up to a minute for the display and the server to both be ready. Still black after that? SSH in and check:
```bash
journalctl --user -u midireef-kiosk -n 50
systemctl status midireef-server
```

**Touch registers as clicks, but no swiping or multi-touch.** The installer disables Pi OS's default mouse-emulation for touch input, but this needs a reboot to fully apply. Reboot once if you haven't since installing.

**No MIDI device appears.** Confirm it's class-compliant USB MIDI (works with no driver install on any OS) — anything that needs a vendor driver on Windows/Mac won't work here either. Check what the Pi actually sees:
```bash
ssh <username>@<hostname>.local aconnect -l
```

**No sound on playback/recording.** This is almost always the *output device* selection, not a bug — open the Audio screen (**RC**), check what's selected under "Output", and use **Test tone** to check the path in isolation before troubleshooting the recording itself.

**Something's misbehaving after an update.** Restart the server:
```bash
sudo systemctl restart midireef-server
```
The kiosk reconnects and reloads itself automatically — no need to touch the browser.

**Starting over.** Your projects live in `~/midireef/data/` and survive re-running the installer. To fully remove MidiReef:
```bash
sudo systemctl disable --now midireef-server
systemctl --user disable --now midireef-kiosk
rm -rf ~/midireef ~/.config/systemd/user/midireef-kiosk.service
sudo rm -f /etc/systemd/system/midireef-server.service /etc/sudoers.d/midireef-net
```

## Updating

```bash
cd ~/midireef/src && git pull && ./deploy/install.sh
```

Rebuilds and restarts the service. Your saved projects are untouched.
