//! Lane-Controls: die "Schnellbedienung" einer Lane — Drum-/Note-Buttons,
//! Macro-Knobs, MIDI-Signal-Buttons. Feuert live, direkt am Playback-Server
//! vorbei (wie die Live-Controls im Dashboard), unabhängig von der
//! Baustein-Bibliothek/Engine.
//!
//! Öffnet als Overlay über der Sequencer-Übersicht (🎛-Taste in der Lane-
//! Zeile). Tap auf eine Kachel feuert sie (Press/Release je nach Art);
//! "✕" in der Ecke entfernt sie; "＋" öffnet einen rollenabhängigen
//! Schnell-Anlegen-Dialog.

import { Container, Graphics } from "pixi.js";
import type { Store, Lane, Device, Block, LaneControl } from "../state";
import { button, label } from "./widgets";
import type { TouchKeyboard } from "./keyboard";
import { PAL } from "../theme";

type Send = (cmd: object) => void;

const TOP = 100;
const TILE_W = 100;
const TILE_H = 76;
const TILE_GAP = 12;

export class LaneControlsScreen {
  readonly container = new Container();
  private bg = new Graphics();
  private body = new Container();
  private popup = new Container();
  private store: Store;
  private send: Send;
  private keyboard: TouchKeyboard;
  private w = 0;
  private h = 0;
  private laneId?: string;
  private activeToggles = new Set<string>();

  constructor(store: Store, send: Send, keyboard: TouchKeyboard) {
    this.store = store;
    this.send = send;
    this.keyboard = keyboard;
    this.container.visible = false;
    this.container.addChild(this.bg);
    this.container.addChild(this.body);
    this.container.addChild(this.popup);
    store.subscribe(() => {
      if (this.container.visible) this.rebuild();
    });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (this.container.visible) this.rebuild();
  }

  open(laneId: string) {
    this.laneId = laneId;
    this.container.visible = true;
    this.rebuild();
  }

  close() {
    this.container.visible = false;
    this.laneId = undefined;
    this.popup.removeChildren();
  }

  private findLaneAndDevice(): { lane: Lane; device: Device } | undefined {
    if (!this.laneId) return undefined;
    for (const dev of this.store.project?.devices ?? []) {
      const l = dev.lanes.find((l) => l.id === this.laneId);
      if (l) return { lane: l, device: dev };
    }
    return undefined;
  }

  private editNumber(current: number, min: number, max: number, onSet: (n: number) => void) {
    this.keyboard.open(String(current), 3, (v) => {
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) onSet(Math.min(max, Math.max(min, n)));
    });
  }

  // ── Aufbau ─────────────────────────────────────────────────────────────────

  private rebuild() {
    this.body.removeChildren();
    this.bg.clear();
    this.bg.rect(0, TOP, this.w, this.h - TOP).fill({ color: PAL.waterDeep, alpha: 0.98 });

    const back = button("← Zurück", { w: 130, h: 40, color: PAL.btnAlt, fontSize: 17 }, () => this.close());
    back.x = 16;
    back.y = TOP + 12;
    this.body.addChild(back);

    const found = this.findLaneAndDevice();
    if (!found) {
      const gone = label("Lane nicht mehr vorhanden.", 18, PAL.textDim, "400");
      gone.x = 16;
      gone.y = TOP + 70;
      this.body.addChild(gone);
      return;
    }
    const { lane, device } = found;

    const nameTxt = label(lane.name, 24, PAL.text, "700");
    nameTxt.x = 160;
    nameTxt.y = TOP + 16;
    this.body.addChild(nameTxt);

    const roleTxt = label(lane.role.toUpperCase(), 13, PAL.textDim, "600");
    roleTxt.x = 160;
    roleTxt.y = TOP + 48;
    this.body.addChild(roleTxt);

    const gridX = 16;
    const gridY = TOP + 90;
    const cols = Math.max(1, Math.floor((this.w - gridX * 2) / (TILE_W + TILE_GAP)));

    const controls = lane.controls ?? [];
    controls.forEach((ctrl, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const tile = this.controlTile(ctrl, lane.id);
      tile.x = gridX + col * (TILE_W + TILE_GAP);
      tile.y = gridY + row * (TILE_H + TILE_GAP);
      this.body.addChild(tile);
    });

    const addIdx = controls.length;
    const addTile = button("＋", { w: TILE_W, h: TILE_H, color: PAL.btnAlt, fontSize: 30 }, () =>
      this.openAddPicker(lane, device),
    );
    addTile.x = gridX + (addIdx % cols) * (TILE_W + TILE_GAP);
    addTile.y = gridY + Math.floor(addIdx / cols) * (TILE_H + TILE_GAP);
    this.body.addChild(addTile);
  }

  private controlTile(ctrl: LaneControl, laneId: string): Container {
    const c = new Container();
    const active = this.activeToggles.has(ctrl.id);
    const g = new Graphics();
    g.roundRect(0, 0, TILE_W, TILE_H, 12).fill({ color: active ? PAL.btnActive : PAL.btn, alpha: 0.9 });
    g.roundRect(0, 0, TILE_W, TILE_H, 12).stroke({ color: PAL.line, width: 1.5, alpha: 0.3 });
    c.addChild(g);

    const t = label(ctrl.label || ctrl.kind, 14, active ? PAL.ink : PAL.text, "600");
    t.anchor.set(0.5);
    t.x = TILE_W / 2;
    t.y = ctrl.kind === "macroKnob" ? TILE_H / 2 - 8 : TILE_H / 2;
    c.addChild(t);

    if (ctrl.kind === "macroKnob") {
      const vt = label(`${ctrl.value ?? 0}`, 12, active ? PAL.ink : PAL.textDim, "400");
      vt.anchor.set(0.5);
      vt.x = TILE_W / 2;
      vt.y = TILE_H / 2 + 14;
      c.addChild(vt);
    }

    this.wireTileInteraction(c, ctrl, laneId);

    // Entfernen — eigenes Hit-Target statt Long-Press, damit es nicht mit
    // dem Halten eines Momentary-Controls kollidiert.
    const del = new Graphics();
    del.circle(TILE_W - 12, 12, 10).fill({ color: PAL.danger, alpha: 0.85 });
    del.eventMode = "static";
    del.cursor = "pointer";
    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    del.on("pointerdown", stop);
    del.on("pointerup", stop);
    del.on("pointertap", (e) => {
      e.stopPropagation();
      this.send({ t: "laneControl.remove", laneId, controlId: ctrl.id });
    });
    c.addChild(del);
    const delX = label("✕", 11, PAL.white, "700");
    delX.anchor.set(0.5);
    delX.x = TILE_W - 12;
    delX.y = 12;
    c.addChild(delX);

    return c;
  }

  private wireTileInteraction(c: Container, ctrl: LaneControl, laneId: string) {
    c.eventMode = "static";
    c.cursor = "pointer";

    if (ctrl.kind === "macroKnob") {
      let dragging = false;
      let startY = 0;
      let startValue = ctrl.value ?? 0;
      c.on("pointerdown", (e) => {
        dragging = true;
        startY = e.global.y;
        startValue = ctrl.value ?? 0;
      });
      c.on("globalpointermove", (e) => {
        if (!dragging) return;
        const dy = startY - e.global.y;
        const value = Math.min(127, Math.max(0, Math.round(startValue + dy * 0.7)));
        this.send({ t: "laneControl.setValue", laneId, controlId: ctrl.id, value });
      });
      const end = () => (dragging = false);
      c.on("pointerup", end);
      c.on("pointerupoutside", end);
      return;
    }

    const momentary = ctrl.kind === "drumButton" ? ctrl.action === "trigger" : ctrl.trigger === "momentary";
    const isToggle = ctrl.kind !== "drumButton" && ctrl.trigger === "toggle";

    if (momentary) {
      c.on("pointerdown", () => {
        c.alpha = 0.6;
        this.send({ t: "laneControl.press", laneId, controlId: ctrl.id });
      });
      const release = () => {
        c.alpha = 1;
        this.send({ t: "laneControl.release", laneId, controlId: ctrl.id });
      };
      c.on("pointerup", release);
      c.on("pointerupoutside", release);
    } else if (isToggle) {
      c.on("pointertap", () => {
        if (this.activeToggles.has(ctrl.id)) {
          this.activeToggles.delete(ctrl.id);
          this.send({ t: "laneControl.release", laneId, controlId: ctrl.id });
        } else {
          this.activeToggles.add(ctrl.id);
          this.send({ t: "laneControl.press", laneId, controlId: ctrl.id });
        }
        this.rebuild();
      });
    } else {
      // oneShot, oder drumButton mit action="muteToggle" (Server toggelt beim Press).
      c.on("pointertap", () => {
        this.send({ t: "laneControl.press", laneId, controlId: ctrl.id });
      });
    }
  }

  // ── Schnell-Anlegen (rollenabhängig) ─────────────────────────────────────────

  private openAddPicker(lane: Lane, device: Device) {
    this.popup.removeChildren();
    const overlay = new Graphics();
    overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.7 });
    overlay.eventMode = "static";
    overlay.on("pointertap", () => this.popup.removeChildren());
    this.popup.addChild(overlay);

    const rows: { text: string; onTap: () => void }[] = [];

    const addNote = () => {
      this.popup.removeChildren();
      this.editNumber(60, 0, 127, (note) =>
        this.send({
          t: "laneControl.add",
          laneId: lane.id,
          control: { kind: "note", label: `N${note}`, note, velocity: 100, trigger: "momentary" },
        }),
      );
    };

    switch (lane.role) {
      case "melody":
      case "chord":
      case "arp":
        rows.push({ text: "Note hinzufügen", onTap: addNote });
        break;
      case "beat": {
        rows.push({
          text: "Trigger-Note",
          onTap: () => {
            this.popup.removeChildren();
            this.editNumber(36, 0, 127, (note) =>
              this.send({
                t: "laneControl.add",
                laneId: lane.id,
                control: { kind: "drumButton", label: `N${note}`, action: "trigger", note, velocity: 100 },
              }),
            );
          },
        });
        const beatBlocks = (device.blocks ?? []).filter(
          (b) => b.type === "beat" && lane.slots.some((s) => s.blockId === b.id),
        );
        if (beatBlocks.length > 0) {
          rows.push({ text: "Mute-Taste", onTap: () => this.openMuteTargetPicker(lane, beatBlocks) });
        }
        break;
      }
      case "cc":
        rows.push({
          text: "Macro-Knob (CC-Nummer)",
          onTap: () => {
            this.popup.removeChildren();
            this.editNumber(74, 0, 127, (ccNumber) =>
              this.send({
                t: "laneControl.add",
                laneId: lane.id,
                control: { kind: "macroKnob", label: `CC${ccNumber}`, ccNumber, min: 0, max: 127, value: 0 },
              }),
            );
          },
        });
        break;
      case "programChange":
        rows.push({
          text: "Programm-Taste",
          onTap: () => {
            this.popup.removeChildren();
            this.editNumber(0, 0, 127, (program) =>
              this.send({
                t: "laneControl.add",
                laneId: lane.id,
                control: {
                  kind: "midiSignal",
                  label: `PC${program}`,
                  message: { atStep: 0, kind: "programChange", data1: program },
                  trigger: "oneShot",
                },
              }),
            );
          },
        });
        break;
      case "patternShift":
        rows.push({
          text: "Pattern-Taste (CC-Nummer)",
          onTap: () => {
            this.popup.removeChildren();
            this.editNumber(0, 0, 127, (cc) =>
              this.send({
                t: "laneControl.add",
                laneId: lane.id,
                control: {
                  kind: "midiSignal",
                  label: `CC${cc}`,
                  message: { atStep: 0, kind: "cc", data1: cc, data2: 127 },
                  trigger: "oneShot",
                },
              }),
            );
          },
        });
        break;
    }

    this.showPopupMenu("Control hinzufügen", rows);
  }

  private openMuteTargetPicker(lane: Lane, beatBlocks: Block[]) {
    const rows: { text: string; onTap: () => void }[] = [];
    for (const b of beatBlocks) {
      for (const line of b.lines ?? []) {
        rows.push({
          text: `${b.name} / ${line.name}`,
          onTap: () => {
            this.popup.removeChildren();
            this.send({
              t: "laneControl.add",
              laneId: lane.id,
              control: {
                kind: "drumButton",
                label: line.name.slice(0, 8),
                action: "muteToggle",
                note: line.note,
                velocity: 100,
                targetBlockId: b.id,
                targetLineId: line.id,
              },
            });
          },
        });
      }
    }
    this.showPopupMenu("Beat-Line wählen", rows);
  }

  /** Kleines Popup-Menü — Titel + Liste tapbarer Zeilen (mirrors overview.ts's Picker-Stil). */
  private showPopupMenu(title: string, rows: { text: string; onTap: () => void }[]) {
    this.popup.removeChildren();
    const overlay = new Graphics();
    overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.7 });
    overlay.eventMode = "static";
    overlay.on("pointertap", () => this.popup.removeChildren());
    this.popup.addChild(overlay);

    const boxW = Math.min(460, this.w - 40);
    const boxH = 90 + Math.max(1, rows.length) * 58;
    const box = new Container();
    box.x = (this.w - boxW) / 2;
    box.y = Math.max(120, (this.h - boxH) / 2);
    const bg = new Graphics();
    bg.roundRect(0, 0, boxW, boxH, 18).fill({ color: PAL.panel, alpha: 0.98 });
    bg.roundRect(0, 0, boxW, boxH, 18).stroke({ color: PAL.line, width: 2, alpha: 0.35 });
    box.addChild(bg);

    const titleTxt = label(title, 20, PAL.text, "700");
    titleTxt.x = 20;
    titleTxt.y = 16;
    box.addChild(titleTxt);

    rows.forEach((r, i) => {
      const b = button(r.text, { w: boxW - 40, h: 46, color: PAL.btn, fontSize: 15 }, r.onTap);
      b.x = 20;
      b.y = 58 + i * 58;
      box.addChild(b);
    });

    this.popup.addChild(box);
  }
}
