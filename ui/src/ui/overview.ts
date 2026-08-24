//! Sequencer-Overview: schwebende Device-Panels mit Lanes (Rollen, En/Mu/Solo),
//! Device/Lane anlegen, umbenennen (Touch-Keyboard) und Rollen-Picker.

import { Container, Graphics } from "pixi.js";
import type { Store, Device, Lane } from "../state";
import { button, label, pillToggle } from "./widgets";
import type { TouchKeyboard } from "./keyboard";
import { PAL, hexToNum } from "../theme";

type Send = (cmd: object) => void;

const ROLES: { role: string; label: string }[] = [
  { role: "melody", label: "Melodie" },
  { role: "beat", label: "Beat" },
  { role: "cc", label: "CC" },
  { role: "programChange", label: "Prog" },
  { role: "patternShift", label: "Pattern" },
  { role: "chord", label: "Chord" },
  { role: "arp", label: "Arp" },
];

const TOP = 100; // unter der Transport-Leiste
const PANEL_PAD = 16;
const HEADER_H = 60;
const LANE_H = 58;
const LONG_PRESS_MS = 500;

export class SequencerOverview {
  readonly container = new Container();
  private content = new Container();
  private popup = new Container();
  private store: Store;
  private send: Send;
  private keyboard: TouchKeyboard;
  private onOpenBlock: (blockId: string) => void;
  private onOpenLaneControls: (laneId: string) => void;
  private w = 0;
  private h = 0;
  private scrollY = 0;

  constructor(
    store: Store,
    send: Send,
    keyboard: TouchKeyboard,
    onOpenBlock: (blockId: string) => void,
    onOpenLaneControls: (laneId: string) => void,
  ) {
    this.store = store;
    this.send = send;
    this.keyboard = keyboard;
    this.onOpenBlock = onOpenBlock;
    this.onOpenLaneControls = onOpenLaneControls;
    this.container.addChild(this.content);
    this.container.addChild(this.popup);
    store.subscribe(() => this.rebuild());
    this.enableDragScroll();
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rebuild();
  }

  private enableDragScroll() {
    let dragging = false;
    let lastY = 0;
    this.content.eventMode = "static";
    this.content.on("pointerdown", (e) => {
      dragging = true;
      lastY = e.global.y;
    });
    this.content.on("pointerup", () => (dragging = false));
    this.content.on("pointerupoutside", () => (dragging = false));
    this.content.on("globalpointermove", (e) => {
      if (!dragging) return;
      const dy = e.global.y - lastY;
      lastY = e.global.y;
      this.scrollY = Math.min(0, this.scrollY + dy);
      this.content.y = this.scrollY;
    });
  }

  private rebuild() {
    this.content.removeChildren();
    const proj = this.store.project;
    const ports = this.store.midiOutputs;
    let y = TOP;

    // Device anlegen — nur möglich, wenn MIDI-Ausgänge gefunden wurden.
    if (ports.length > 0) {
      const addDev = button(
        "＋  Device",
        { w: 200, h: 48, color: PAL.btnAlt, fontSize: 22 },
        () => this.openPortPicker(),
      );
      addDev.x = PANEL_PAD;
      addDev.y = y;
      this.content.addChild(addDev);
    } else {
      const noMidi = label(
        "Keine MIDI-Geräte gefunden — schließ ein Gerät an.",
        18,
        PAL.textDim,
        "600",
      );
      noMidi.x = PANEL_PAD;
      noMidi.y = y + 12;
      this.content.addChild(noMidi);
    }
    y += 68;

    if (!proj || proj.devices.length === 0) {
      const hint = label(
        ports.length > 0
          ? "Noch keine Devices — oben „＋ Device“ tippen."
          : "",
        18,
        PAL.textDim,
        "400",
      );
      hint.x = PANEL_PAD;
      hint.y = y;
      this.content.addChild(hint);
      return;
    }

    for (const dev of proj.devices) {
      const panelH = HEADER_H + dev.lanes.length * (LANE_H + 6) + PANEL_PAD;
      this.content.addChild(this.devicePanel(dev, PANEL_PAD, y, this.w - PANEL_PAD * 2, panelH));
      y += panelH + 16;
    }
  }

  /** Baustein-Kachel: kurzer Tap → onTap (trigger), langer Druck → onLongPress (Editor öffnen). */
  private blockTile(
    text: string,
    w: number,
    h: number,
    textColor: number,
    opts: { onTap: () => void; onLongPress?: () => void },
  ): Container {
    const c = new Container();
    const g = new Graphics();
    g.roundRect(0, 0, w, h, 10).fill({ color: PAL.btn, alpha: 0.9 });
    g.roundRect(0, 0, w, h, 10).stroke({ color: PAL.line, width: 1.5, alpha: 0.3 });
    c.addChild(g);

    const t = label(text, 15, textColor, "600");
    t.anchor.set(0.5);
    t.x = w / 2;
    t.y = h / 2;
    c.addChild(t);

    c.eventMode = "static";
    c.cursor = "pointer";

    let timer: number | undefined;
    let longPressed = false;
    c.on("pointerdown", () => {
      longPressed = false;
      c.alpha = 0.6;
      if (opts.onLongPress) {
        timer = window.setTimeout(() => {
          longPressed = true;
          c.alpha = 1;
          opts.onLongPress!();
        }, LONG_PRESS_MS);
      }
    });
    const end = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      c.alpha = 1;
      if (!longPressed) opts.onTap();
    };
    c.on("pointerup", end);
    c.on("pointerupoutside", () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      c.alpha = 1;
    });

    return c;
  }

  private devicePanel(dev: Device, x: number, y: number, w: number, h: number): Container {
    const c = new Container();
    c.x = x;
    c.y = y;

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, 18).fill({ color: PAL.panel, alpha: 0.55 });
    bg.roundRect(0, 0, w, h, 18).stroke({ color: PAL.line, width: 1.5, alpha: 0.25 });
    c.addChild(bg);

    // Header: Name (tap → rename)
    const name = label(dev.name, 26, PAL.text, "700");
    name.x = 18;
    name.y = 12;
    name.eventMode = "static";
    name.cursor = "pointer";
    name.on("pointertap", () =>
      this.keyboard.open(dev.name, 24, (v) => {
        if (v) this.send({ t: "device.rename", deviceId: dev.id, name: v });
      }),
    );
    c.addChild(name);

    const port = label(
      dev.midiOutPort ? `→ ${dev.midiOutPort}` : "→ kein MIDI-Port",
      13,
      PAL.textDim,
      "400",
    );
    port.x = 18;
    port.y = 40;
    c.addChild(port);

    // Kanal — tippen schaltet zum nächsten Kanal (1–16) weiter. Gilt für
    // Lanes/Bausteine dieses Devices (sofern keine Lane einen eigenen
    // Channel-Override hat). Live-Controls senden dagegen immer auf dem
    // beim MIDI-Learn aufgezeichneten Kanal, unabhängig hiervon.
    const chBtn = button(`Ch ${dev.channel}`, { w: 74, h: 40, color: PAL.btn, fontSize: 16 }, () => {
      const next = (dev.channel % 16) + 1;
      this.send({ t: "device.setChannel", deviceId: dev.id, channel: next });
    });
    chBtn.x = w - 344;
    chBtn.y = 10;
    c.addChild(chBtn);

    // Transpose — globaler Halbton-Versatz, live verstellbar (z.B. um mehrere
    // Lanes/Devices zur Laufzeit in dieselbe Tonart zu bringen). "−"/"+" statt
    // Texteingabe, weil das Touch-Keyboard keine Minus-Taste hat.
    const transpose = dev.transpose ?? 0;
    const negBtn = button("–", { w: 28, h: 40, color: PAL.btn, fontSize: 20 }, () =>
      this.send({ t: "device.setTranspose", deviceId: dev.id, transpose: transpose - 1 }),
    );
    negBtn.x = w - 470;
    negBtn.y = 10;
    c.addChild(negBtn);

    const tLabel = label(`T ${transpose > 0 ? "+" : ""}${transpose}`, 13, PAL.textDim, "600");
    tLabel.anchor.set(0.5, 0.5);
    tLabel.x = w - 470 + 28 + 27;
    tLabel.y = 30;
    c.addChild(tLabel);

    const posBtn = button("+", { w: 28, h: 40, color: PAL.btn, fontSize: 20 }, () =>
      this.send({ t: "device.setTranspose", deviceId: dev.id, transpose: transpose + 1 }),
    );
    posBtn.x = w - 470 + 28 + 54;
    posBtn.y = 10;
    c.addChild(posBtn);

    // + Lane
    const addLane = button(
      "＋ Lane",
      { w: 110, h: 40, color: PAL.btn, fontSize: 18 },
      () => this.openRolePicker(dev.id),
    );
    addLane.x = w - 250;
    addLane.y = 10;
    c.addChild(addLane);

    // Device löschen
    const del = button(
      "✕",
      { w: 44, h: 40, color: PAL.danger, fontSize: 22 },
      () => this.send({ t: "device.delete", deviceId: dev.id }),
    );
    del.x = w - 60;
    del.y = 10;
    c.addChild(del);

    // Lanes
    let ly = HEADER_H;
    for (const lane of dev.lanes) {
      c.addChild(this.laneRow(lane, dev, 12, ly, w - 24));
      ly += LANE_H + 6;
    }
    return c;
  }

  private laneRow(lane: Lane, dev: Device, x: number, y: number, w: number): Container {
    const c = new Container();
    c.x = x;
    c.y = y;

    const bg = new Graphics();
    bg.roundRect(0, 0, w, LANE_H, 12).fill({
      color: PAL.panelDeep,
      alpha: lane.enabled ? 0.85 : 0.4,
    });
    c.addChild(bg);

    // Farb-Chip
    const chip = new Graphics();
    chip.roundRect(0, 0, 8, LANE_H, 4).fill({ color: hexToNum(lane.color) });
    c.addChild(chip);

    // Name (tap → rename)
    const name = label(lane.name, 20, PAL.text, "600");
    name.x = 22;
    name.y = 10;
    name.eventMode = "static";
    name.cursor = "pointer";
    name.on("pointertap", () =>
      this.keyboard.open(lane.name, 24, (v) => {
        if (v) this.send({ t: "lane.rename", laneId: lane.id, name: v });
      }),
    );
    c.addChild(name);

    // Rollen-Badge
    const badge = new Graphics();
    badge.roundRect(22, 34, 70, 18, 8).fill({ color: PAL.white, alpha: 0.12 });
    c.addChild(badge);
    const roleTxt = label(roleLabel(lane.role), 12, PAL.text, "600");
    roleTxt.x = 28;
    roleTxt.y = 35;
    c.addChild(roleTxt);

    // Bausteine als Kacheln (aus der Device-Bibliothek aufgelöst).
    // Kurzer Tap löst aus (block.trigger); langer Druck öffnet den
    // Baustein-Detail-Editor (Noten/Steps bearbeiten).
    const tileW = 60;
    const tileH = 40;
    const gap = 6;
    const tileMaxX = w - 254; // nicht in die Toggles/🎛-Taste laufen
    let tx = 100;
    for (const slot of lane.slots ?? []) {
      if (tx > tileMaxX) break;
      const blk = dev.blocks?.find((b) => b.id === slot.blockId);
      const tname = (blk?.name ?? "?").slice(0, 6);
      const tile = this.blockTile(tname, tileW, tileH, hexToNum(lane.color), {
        onTap: () => this.send({ t: "block.trigger", laneId: lane.id, slotId: slot.id }),
        onLongPress: blk ? () => this.onOpenBlock(blk.id) : undefined,
      });
      tile.x = tx;
      tile.y = 9;
      c.addChild(tile);
      tx += tileW + gap;
    }
    // Baustein hinzufügen.
    if (tx <= tileMaxX) {
      const add = button("＋", { w: 34, h: 40, color: PAL.btnAlt, fontSize: 20 }, () =>
        this.send({ t: "lane.addBlock", laneId: lane.id }),
      );
      add.x = tx;
      add.y = 9;
      c.addChild(add);
    }

    // Lane-Controls (Schnellbedienung: Drum-/Note-Buttons, Macro-Knobs, …)
    const ctrlBtn = button("🎛", { w: 40, h: 40, color: PAL.btnAlt, fontSize: 18 }, () =>
      this.onOpenLaneControls(lane.id),
    );
    ctrlBtn.x = w - 238;
    ctrlBtn.y = 9;
    c.addChild(ctrlBtn);

    // En / Mu / So Toggles
    const e = pillToggle("E", lane.enabled, () =>
      this.send({ t: "lane.setEnabled", laneId: lane.id, enabled: !lane.enabled }),
    );
    e.x = w - 190;
    e.y = 9;
    c.addChild(e);

    const m = pillToggle("M", lane.muted, () =>
      this.send({ t: "lane.setMuted", laneId: lane.id, muted: !lane.muted }),
    );
    m.x = w - 142;
    m.y = 9;
    c.addChild(m);

    const s = pillToggle("S", lane.solo, () =>
      this.send({ t: "lane.setSolo", laneId: lane.id, solo: !lane.solo }),
    );
    s.x = w - 94;
    s.y = 9;
    c.addChild(s);

    const del = button("✕", { w: 40, h: 40, color: PAL.danger, fontSize: 18 }, () =>
      this.send({ t: "lane.delete", laneId: lane.id }),
    );
    del.x = w - 44;
    del.y = 9;
    c.addChild(del);

    return c;
  }

  /** Port-Picker: legt ein Device für einen gefundenen MIDI-Ausgang an. */
  private openPortPicker() {
    const ports = this.store.midiOutputs;
    if (ports.length === 0) return;
    this.popup.removeChildren();
    const overlay = new Graphics();
    overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.75 });
    overlay.eventMode = "static";
    overlay.on("pointertap", () => this.popup.removeChildren());
    this.popup.addChild(overlay);

    const boxW = Math.min(560, this.w - 40);
    const rows = ports.length;
    const boxH = 90 + rows * 66;
    const box = new Container();
    box.x = (this.w - boxW) / 2;
    box.y = Math.max(120, (this.h - boxH) / 2);
    const bg = new Graphics();
    bg.roundRect(0, 0, boxW, boxH, 18).fill({ color: PAL.panel, alpha: 0.98 });
    bg.roundRect(0, 0, boxW, boxH, 18).stroke({ color: PAL.line, width: 2, alpha: 0.35 });
    box.addChild(bg);

    const title = label("MIDI-Ausgang wählen", 22, PAL.text, "700");
    title.x = 20;
    title.y = 16;
    box.addChild(title);

    ports.forEach((portName, i) => {
      const b = button(
        portName,
        { w: boxW - 40, h: 54, color: PAL.btn, fontSize: 18 },
        () => {
          this.send({ t: "device.create", name: portName, midiOutPort: portName });
          this.popup.removeChildren();
        },
      );
      b.x = 20;
      b.y = 58 + i * 66;
      box.addChild(b);
    });

    this.popup.addChild(box);
  }

  private openRolePicker(deviceId: string) {
    this.popup.removeChildren();
    const overlay = new Graphics();
    overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.7 });
    overlay.eventMode = "static";
    overlay.on("pointertap", () => this.popup.removeChildren());
    this.popup.addChild(overlay);

    const boxW = Math.min(520, this.w - 40);
    const boxH = 260;
    const box = new Container();
    box.x = (this.w - boxW) / 2;
    box.y = (this.h - boxH) / 2;
    const bg = new Graphics();
    bg.roundRect(0, 0, boxW, boxH, 18).fill({ color: PAL.panel, alpha: 0.98 });
    bg.roundRect(0, 0, boxW, boxH, 18).stroke({ color: PAL.line, width: 2, alpha: 0.35 });
    box.addChild(bg);

    const title = label("Lane-Typ wählen", 22, PAL.text, "700");
    title.x = 20;
    title.y = 16;
    box.addChild(title);

    const cols = 4;
    const bw = (boxW - 20 * (cols + 1)) / cols;
    ROLES.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const b = button(
        r.label,
        { w: bw, h: 60, color: PAL.btn, fontSize: 18 },
        () => {
          this.send({ t: "lane.create", deviceId, role: r.role });
          this.popup.removeChildren();
        },
      );
      b.x = 20 + col * (bw + 20);
      b.y = 64 + row * 76;
      box.addChild(b);
    });

    this.popup.addChild(box);
  }
}

function roleLabel(role: string): string {
  return ROLES.find((r) => r.role === role)?.label ?? role;
}
