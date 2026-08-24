//! Dashboard (Home): zeigt gelernte Taster (Note) und Drehregler (CC).
//!
//! Bedienung wie Touch (Maus = ein Finger):
//!  - Taster antippen  → sendet Note-On/Off ans Gerät.
//!  - Drehregler vertikal ziehen → ändert CC-Wert und sendet CC.
//!  - Rechtsklick / Zwei-Finger (ein Finger auf Control + zweiter tippt) → Kontextmenü
//!    mit „Verschieben", „Gerät …" und „Entfernen".
//!  - „Verschieben" schaltet den Move-Modus ein (Controls ziehbar), Verlassen per „Fertig".
//!  - „Gerät …" ordnet das Control einem Device zu; Name erscheint dann am Button,
//!    Taster mit Note-Mapping zeigen zusätzlich die gesendete Frequenz (Hz).
//!  - Ein Finger auf freier Fläche ziehen → Dashboard verschieben (Pan).
//!  - Mausrad (Trackpad-Scroll) → Pan; Strg/⌘+Mausrad oder Zwei-Finger-Pinch → Zoom.
//!  - „Zentrieren"-Button (oben rechts) setzt Pan/Zoom zurück.
//!  - Langer Druck auf freie Fläche → MIDI-Learn.

import { Container, Graphics } from "pixi.js";
import type { Store } from "../state";
import { button, label } from "./widgets";
import type { TouchKeyboard } from "./keyboard";
import { PAL } from "../theme";

type Send = (cmd: object) => void;

const TOP = 100;
const LONG_PRESS_MS = 700;

interface LiveControl {
  id: string;
  name: string;
  kind: string;
  mapping?: { channel: number; kind: string; number: number };
  deviceId?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  value?: number;
}

/** MIDI-Notennummer → Frequenz in Hz (A4 = 69 = 440 Hz, 12-TET). */
function noteToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

interface Pt {
  x: number;
  y: number;
}

export class MainScreen {
  readonly container = new Container();
  private hitArea = new Graphics();
  private controlsLayer = new Container();
  private overlay = new Container(); // Learn-Overlay
  private menuLayer = new Container(); // Kontextmenü + Move-Leiste
  private toastLayer = new Container(); // MIDI-Sendefehler-Hinweis
  private toastTimer?: number;
  private resetBtn: Container;
  private store: Store;
  private send: Send;
  private keyboard: TouchKeyboard;
  private w = 0;
  private h = 0;
  private armed = false;
  private pressTimer?: number;

  private editMode = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private panStart?: { x: number; y: number; panX: number; panY: number };
  private isPanning = false;
  private pressedControl?: LiveControl;
  private activeNoteId?: string;
  private pointers = new Map<number, Pt>();
  private pinch?: { startDist: number; startZoom: number };

  constructor(store: Store, send: Send, keyboard: TouchKeyboard) {
    this.store = store;
    this.send = send;
    this.keyboard = keyboard;

    this.container.addChild(this.hitArea);
    this.container.addChild(this.controlsLayer);
    this.container.addChild(this.overlay);
    this.container.addChild(this.menuLayer);
    this.container.addChild(this.toastLayer);

    // Fest im Bildschirm verankert (nicht Teil von controlsLayer), damit der
    // Button beim Verschieben/Zoomen des Dashboards an Ort und Stelle bleibt.
    this.resetBtn = button("Zentrieren", { w: 110, h: 36, color: PAL.btnAlt, fontSize: 14 }, () =>
      this.resetView(),
    );
    this.container.addChild(this.resetBtn);

    this.hitArea.eventMode = "static";
    this.hitArea.on("pointerdown", (e) => this.onBgDown(e.pointerId, e.global.x, e.global.y));
    this.hitArea.on("pointerup", (e) => this.onBgUp(e.pointerId));
    this.hitArea.on("pointerupoutside", (e) => this.onBgUp(e.pointerId));
    this.hitArea.on("globalpointermove", (e) => this.onMove(e.pointerId, e.global.x, e.global.y));
    this.hitArea.on("wheel", (e) => this.onWheel(e as unknown as WheelEvent));

    store.subscribe(() => this.rebuild());
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.resetBtn.x = w - 126;
    this.resetBtn.y = TOP + 8;
    this.rebuild();
  }

  // ── Zoom & Pan ────────────────────────────────────────────────────────────

  private applyZoom() {
    this.zoom = Math.min(2, Math.max(0.3, this.zoom));
    const cx = this.w / 2;
    const cy = (TOP + this.h) / 2;
    this.controlsLayer.scale.set(this.zoom);
    this.controlsLayer.x = cx * (1 - this.zoom) + this.panX;
    this.controlsLayer.y = cy * (1 - this.zoom) + this.panY;
  }

  /** Trackpad: Scrollen ohne Modifier = verschieben (Pan), Strg/⌘+Scrollen
   *  bzw. Pinch = zoomen — deckt sich mit dem, was Browser für Pinch-Geste
   *  auf dem Trackpad ohnehin als „wheel + ctrlKey" melden. */
  private onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      this.zoom *= 1 - e.deltaY * 0.001;
      this.applyZoom();
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.applyZoom();
    }
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyZoom();
  }

  // ── Hintergrund-Gesten (Pan, MIDI-Learn, Zwei-Finger, Pinch) ───────────────

  private onBgDown(id: number, x: number, y: number) {
    this.pointers.set(id, { x, y });
    this.cancelPress();
    if (this.pointers.size >= 2) {
      this.panStart = undefined;
      this.isPanning = false;
      if (this.pressedControl) {
        this.openContextMenu(this.pressedControl, x, y);
      } else {
        const pts = [...this.pointers.values()];
        this.pinch = { startDist: dist(pts[0], pts[1]), startZoom: this.zoom };
      }
      return;
    }
    if (!this.editMode) {
      this.panStart = { x, y, panX: this.panX, panY: this.panY };
      this.startPress();
    }
  }

  private onBgUp(id: number) {
    this.pointers.delete(id);
    this.cancelPress();
    if (this.pointers.size < 2) this.pinch = undefined;
    if (this.pointers.size === 0) {
      this.panStart = undefined;
      this.isPanning = false;
    }
  }

  private onMove(id: number, x: number, y: number) {
    if (this.pointers.has(id)) this.pointers.set(id, { x, y });
    if (this.pinch && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const d = dist(pts[0], pts[1]);
      if (this.pinch.startDist > 0) {
        this.zoom = this.pinch.startZoom * (d / this.pinch.startDist);
        this.applyZoom();
      }
      return;
    }
    // Einzelner Finger auf freier Fläche gezogen → Dashboard verschieben.
    // Erst ab einer kleinen Schwelle, damit ein Tap für den Lang-Druck
    // (Learn/Keyboard-Menü) nicht sofort als Pan erkannt wird.
    if (this.panStart && this.pointers.size === 1) {
      const dx = x - this.panStart.x;
      const dy = y - this.panStart.y;
      if (!this.isPanning && Math.hypot(dx, dy) > 8) {
        this.isPanning = true;
        this.cancelPress();
      }
      if (this.isPanning) {
        this.panX = this.panStart.panX + dx;
        this.panY = this.panStart.panY + dy;
        this.applyZoom();
      }
    }
  }

  // ── MIDI-Learn ─────────────────────────────────────────────────────────────

  private startPress() {
    if (this.armed) return;
    this.pressTimer = window.setTimeout(() => this.beginLearn(), LONG_PRESS_MS);
  }

  private cancelPress() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = undefined;
    }
  }

  private beginLearn() {
    this.armed = true;
    this.send({ t: "learn.start" });
    this.drawOverlay();
  }

  setArmed(armed: boolean) {
    this.armed = armed;
    this.drawOverlay();
  }

  onLearned(controlId: string, mapping?: { kind: string; channel: number; number: number }) {
    this.armed = false;
    this.drawOverlay();
    // CC ist mehrdeutig: mancher Controller sendet für Taster (z.B. „Play")
    // ebenfalls CC statt Note — Nutzer entscheidet, wie reproduziert wird.
    if (mapping?.kind === "cc") {
      this.openKindPicker(controlId, () => this.promptName(controlId));
    } else {
      this.promptName(controlId);
    }
  }

  private promptName(controlId: string) {
    this.keyboard.open("", 24, (v) => {
      if (v) {
        this.send({ t: "control.assignName", controlId, name: v });
      } else {
        // Cancelled (or submitted empty) — don't leave a nameless stray
        // control behind; the server already created it when the MIDI
        // message was captured, before this prompt ever opened.
        this.send({ t: "control.delete", controlId });
      }
    });
  }

  private openKindPicker(controlId: string, onDone: () => void) {
    this.menuLayer.removeChildren();

    // Cancel (backdrop tap or explicit button) also cleans up the just-
    // learned control — same reasoning as promptName's cancel path.
    const cancel = () => {
      this.menuLayer.removeChildren();
      this.send({ t: "control.delete", controlId });
    };

    const backdrop = new Graphics();
    backdrop.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.6 });
    backdrop.eventMode = "static";
    backdrop.on("pointertap", cancel);
    this.menuLayer.addChild(backdrop);

    const bw = 340;
    const bh = 260;
    const box = new Container();
    box.x = (this.w - bw) / 2;
    box.y = (this.h - bh) / 2;
    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 14).fill({ color: PAL.panel, alpha: 0.98 });
    bg.roundRect(0, 0, bw, bh, 14).stroke({ color: PAL.line, width: 2, alpha: 0.5 });
    box.addChild(bg);

    const title = label("CC learned — how should it act?", 17, PAL.text, "700");
    title.x = 16;
    title.y = 14;
    box.addChild(title);

    const hint = label("e.g. a “Play” button often sends CC instead of Note.", 13, PAL.textDim, "400");
    hint.x = 16;
    hint.y = 38;
    box.addChild(hint);

    const pick = (kind: "knob" | "button") => {
      this.send({ t: "control.setKind", controlId, kind });
      this.menuLayer.removeChildren();
      onDone();
    };

    const knobBtn = button("Knob (turn)", { w: bw - 32, h: 50, color: PAL.btn, fontSize: 17 }, () =>
      pick("knob"),
    );
    knobBtn.x = 16;
    knobBtn.y = 66;
    box.addChild(knobBtn);

    const buttonBtn = button(
      "Button (tap — sends 127/0)",
      { w: bw - 32, h: 50, color: PAL.btn, fontSize: 15 },
      () => pick("button"),
    );
    buttonBtn.x = 16;
    buttonBtn.y = 126;
    box.addChild(buttonBtn);

    const cancelBtn = button("Cancel", { w: bw - 32, h: 44, color: PAL.danger, fontSize: 16 }, cancel);
    cancelBtn.x = 16;
    cancelBtn.y = 186;
    box.addChild(cancelBtn);

    this.menuLayer.addChild(box);
  }

  /** Zeigt kurz einen Hinweis an, wenn der Server MIDI nicht senden konnte. */
  showSendError(message: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastLayer.removeChildren();

    const bw = Math.min(this.w - 32, 560);
    const bh = 64;
    const box = new Container();
    box.x = (this.w - bw) / 2;
    box.y = this.h - bh - 24;
    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 10).fill({ color: PAL.panel, alpha: 0.97 });
    bg.roundRect(0, 0, bw, bh, 10).stroke({ color: PAL.white, width: 1.5, alpha: 0.4 });
    box.addChild(bg);

    const t = label(message, 15, PAL.text, "600");
    t.anchor.set(0.5);
    t.x = bw / 2;
    t.y = bh / 2;
    box.addChild(t);

    this.toastLayer.addChild(box);
    this.toastTimer = window.setTimeout(() => this.toastLayer.removeChildren(), 4000);
  }

  private drawOverlay() {
    this.overlay.removeChildren();
    if (!this.armed) return;
    const o = new Graphics();
    o.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.8 });
    o.eventMode = "static";
    o.on("pointertap", () => {
      this.armed = false;
      this.send({ t: "learn.cancel" });
      this.drawOverlay();
    });
    this.overlay.addChild(o);
    const t = label("MIDI-Learn aktiv", 40, PAL.white, "700");
    t.anchor.set(0.5);
    t.x = this.w / 2;
    t.y = this.h / 2 - 40;
    this.overlay.addChild(t);
    const hint = label(
      "Jetzt eine Taste/Regler am MIDI-Gerät bewegen …  (tippen zum Abbrechen)",
      20,
      PAL.textDim,
      "400",
    );
    hint.anchor.set(0.5);
    hint.x = this.w / 2;
    hint.y = this.h / 2 + 12;
    this.overlay.addChild(hint);
  }

  // ── Kontextmenü & Move-Modus ───────────────────────────────────────────────

  private openContextMenu(ctrl: LiveControl, x: number, y: number) {
    // Laufende Note abbrechen.
    if (this.activeNoteId) {
      this.send({ t: "control.release", controlId: this.activeNoteId });
      this.activeNoteId = undefined;
    }
    this.menuLayer.removeChildren();

    const backdrop = new Graphics();
    backdrop.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.001 });
    backdrop.eventMode = "static";
    backdrop.on("pointerdown", () => this.menuLayer.removeChildren());
    this.menuLayer.addChild(backdrop);

    const box = new Container();
    const bw = 200;
    const bh = 172;
    box.x = Math.min(Math.max(8, x), this.w - bw - 8);
    box.y = Math.min(Math.max(TOP + 8, y), this.h - bh - 8);
    const bg = new Graphics();
    bg.rect(0, 0, bw, bh).fill({ color: PAL.panel, alpha: 0.98 });
    bg.rect(0, 0, bw, bh).stroke({ color: PAL.line, width: 2, alpha: 0.5 });
    box.addChild(bg);

    const move = button("Verschieben", { w: bw - 20, h: 44, color: PAL.btn, fontSize: 18 }, () => {
      this.menuLayer.removeChildren();
      this.enterEditMode();
    });
    move.x = 10;
    move.y = 10;
    box.addChild(move);

    const dev = button("Gerät …", { w: bw - 20, h: 44, color: PAL.btn, fontSize: 18 }, () => {
      this.openDevicePicker(ctrl, box.x, box.y);
    });
    dev.x = 10;
    dev.y = 62;
    box.addChild(dev);

    const del = button("Entfernen", { w: bw - 20, h: 44, color: PAL.danger, fontSize: 18 }, () => {
      this.menuLayer.removeChildren();
      this.send({ t: "control.delete", controlId: ctrl.id });
    });
    del.x = 10;
    del.y = 114;
    box.addChild(del);

    this.menuLayer.addChild(box);
  }

  private openDevicePicker(ctrl: LiveControl, x: number, y: number) {
    this.menuLayer.removeChildren();

    const backdrop = new Graphics();
    backdrop.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.001 });
    backdrop.eventMode = "static";
    backdrop.on("pointerdown", () => this.menuLayer.removeChildren());
    this.menuLayer.addChild(backdrop);

    const devices = this.store.project?.devices ?? [];
    const rows = Math.max(1, devices.length);
    const bw = 220;
    const rowH = 44;
    const bh = 8 + rowH * rows + 8;
    const box = new Container();
    box.x = Math.min(Math.max(8, x), this.w - bw - 8);
    box.y = Math.min(Math.max(TOP + 8, y), this.h - bh - 8);
    const bg = new Graphics();
    bg.rect(0, 0, bw, bh).fill({ color: PAL.panel, alpha: 0.98 });
    bg.rect(0, 0, bw, bh).stroke({ color: PAL.line, width: 2, alpha: 0.5 });
    box.addChild(bg);

    if (devices.length === 0) {
      const empty = label("Kein Gerät angelegt", 15, PAL.textDim, "400");
      empty.x = 12;
      empty.y = 12;
      box.addChild(empty);
    } else {
      devices.forEach((d, i) => {
        const active = ctrl.deviceId === d.id;
        const row = button(d.name, { w: bw - 20, h: rowH - 8, color: active ? PAL.btnActive : PAL.btn, fontSize: 16, textColor: active ? PAL.ink : PAL.text }, () => {
          this.menuLayer.removeChildren();
          this.send({ t: "control.setDevice", controlId: ctrl.id, deviceId: d.id });
        });
        row.x = 10;
        row.y = 8 + i * rowH;
        box.addChild(row);
      });
    }

    this.menuLayer.addChild(box);
  }

  private enterEditMode() {
    this.editMode = true;
    this.rebuild();
    this.drawEditBar();
  }

  private exitEditMode() {
    this.editMode = false;
    this.menuLayer.removeChildren();
    this.rebuild();
  }

  private drawEditBar() {
    this.menuLayer.removeChildren();
    const bar = new Container();
    const info = label("Move-Modus: Controls ziehen", 16, PAL.text, "600");
    info.x = 16;
    info.y = TOP + 12;
    bar.addChild(info);
    const done = button("Fertig", { w: 120, h: 44, color: PAL.btnActive, fontSize: 18, textColor: PAL.ink }, () =>
      this.exitEditMode(),
    );
    done.x = 16;
    done.y = TOP + 40;
    bar.addChild(done);
    this.menuLayer.addChild(bar);
  }

  // ── Aufbau ─────────────────────────────────────────────────────────────────

  private rebuild() {
    this.hitArea.clear();
    this.hitArea.rect(0, TOP, this.w, this.h - TOP).fill({ color: PAL.black, alpha: 0.001 });

    this.controlsLayer.removeChildren();
    this.applyZoom();

    const controls = (this.store.project?.controls as LiveControl[] | undefined) ?? [];

    const heading = label(
      controls.length === 0
        ? "Dashboard — lange auf die Fläche drücken, um MIDI zu lernen."
        : this.editMode
          ? "Dashboard (Move-Modus)"
          : "Dashboard",
      18,
      PAL.textDim,
      "600",
    );
    heading.x = 16;
    heading.y = TOP + 8;
    this.controlsLayer.addChild(heading);

    for (const ctrl of controls) {
      this.controlsLayer.addChild(this.controlWidget(ctrl));
    }
  }

  private deviceName(deviceId?: string | null): string | undefined {
    if (!deviceId) return undefined;
    return this.store.project?.devices?.find((d) => d.id === deviceId)?.name;
  }

  private controlWidget(ctrl: LiveControl): Container {
    const c = new Container();
    c.x = ctrl.x ?? 60;
    c.y = (ctrl.y ?? 60) + TOP + 30;
    const size = ctrl.w ?? 130;
    const isButton = ctrl.kind === "button" || ctrl.mapping?.kind === "note";
    let value = ctrl.value ?? 0;

    const g = new Graphics();
    const draw = () => {
      g.clear();
      if (isButton) {
        g.rect(0, 0, size, size).stroke({ color: PAL.line, width: 3, alpha: 0.7 });
        // Fast bildfüllendes Quadrat.
        const pad = 8;
        g.rect(pad, pad, size - pad * 2, size - pad * 2).fill({ color: PAL.btn, alpha: 0.95 });
      } else {
        g.circle(size / 2, size / 2, size / 2 - 6).stroke({ color: PAL.line, width: 3, alpha: 0.7 });
        g.circle(size / 2, size / 2, size / 2 - 14).fill({ color: PAL.btn, alpha: 0.9 });
        // Zeiger nach Wert (−135°…+135°).
        const ang = (-135 + (value / 127) * 270) * (Math.PI / 180);
        const r = size / 2 - 16;
        g.moveTo(size / 2, size / 2)
          .lineTo(size / 2 + Math.sin(ang) * r, size / 2 - Math.cos(ang) * r)
          .stroke({ color: PAL.white, width: 3, alpha: 0.9 });
      }
    };
    draw();
    c.addChild(g);

    // Info-Block direkt unter dem Button: Gerät, Name, Mapping, Frequenz — als
    // eine zusammenhängende Beschriftung, damit auf einen Blick klar ist,
    // welcher Knopf zu welchem Gerät gehört.
    let infoY = size + 4;
    const deviceName = this.deviceName(ctrl.deviceId);
    if (deviceName) {
      const devTxt = label(deviceName, 13, PAL.white, "700");
      devTxt.anchor.set(0.5, 0);
      devTxt.x = size / 2;
      devTxt.y = infoY;
      c.addChild(devTxt);
      infoY += 20;
    }

    const nameStr = ctrl.name && ctrl.name.length > 0 ? ctrl.name : "(neu)";
    const nameTxt = label(nameStr, 16, PAL.text, "600");
    nameTxt.anchor.set(0.5, 0);
    nameTxt.x = size / 2;
    nameTxt.y = infoY;
    c.addChild(nameTxt);
    infoY += 22;

    if (ctrl.mapping) {
      const map = label(
        `${ctrl.mapping.kind.toUpperCase()} ${ctrl.mapping.number} · Ch${ctrl.mapping.channel}`,
        11,
        PAL.textDim,
        "400",
      );
      map.anchor.set(0.5, 0);
      map.x = size / 2;
      map.y = infoY;
      c.addChild(map);
      infoY += 18;

      if (ctrl.mapping.kind === "note") {
        const freq = label(`${noteToFreq(ctrl.mapping.number).toFixed(1)} Hz`, 11, PAL.textDim, "400");
        freq.anchor.set(0.5, 0);
        freq.x = size / 2;
        freq.y = infoY;
        c.addChild(freq);
        infoY += 18;
      }
    }

    // Interaktion.
    let startGX = 0;
    let startGY = 0;
    let startX = 0;
    let startY = 0;
    let startValue = 0;
    let mode: "none" | "drag" | "turn" = "none";

    c.eventMode = "static";
    c.cursor = "pointer";

    c.on("pointerdown", (e) => {
      this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
      this.pressedControl = ctrl;
      if (e.button === 2) {
        this.openContextMenu(ctrl, e.global.x, e.global.y);
        return;
      }
      startGX = e.global.x;
      startGY = e.global.y;
      startX = c.x;
      startY = c.y;
      if (this.editMode) {
        mode = "drag";
      } else if (isButton) {
        mode = "none";
        g.alpha = 0.6;
        this.activeNoteId = ctrl.id;
        this.send({ t: "control.press", controlId: ctrl.id });
      } else {
        mode = "turn";
        startValue = value;
      }
    });

    c.on("globalpointermove", (e) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.global.x, y: e.global.y });
      }
      if (mode === "drag") {
        c.x = startX + (e.global.x - startGX) / this.zoom;
        c.y = Math.max(TOP + 30, startY + (e.global.y - startGY) / this.zoom);
      } else if (mode === "turn") {
        const dy = startGY - e.global.y; // hoch = mehr
        value = Math.min(127, Math.max(0, Math.round(startValue + dy * 0.7)));
        draw();
        this.send({ t: "control.setValue", controlId: ctrl.id, value });
      }
    });

    const end = (pointerId: number) => {
      this.pointers.delete(pointerId);
      if (this.pressedControl === ctrl) this.pressedControl = undefined;
      if (mode === "drag") {
        const sx = Math.round(c.x);
        const sy = Math.round(c.y - TOP - 30);
        this.send({ t: "control.move", controlId: ctrl.id, x: sx, y: sy });
      } else if (isButton) {
        g.alpha = 1;
        if (this.activeNoteId === ctrl.id) {
          this.send({ t: "control.release", controlId: ctrl.id });
          this.activeNoteId = undefined;
        }
      }
      mode = "none";
    };
    c.on("pointerup", (e) => end(e.pointerId));
    c.on("pointerupoutside", (e) => end(e.pointerId));

    return c;
  }
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
