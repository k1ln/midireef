//! Baustein-Detail: Noten (Melodie) bzw. Steps (Beat) editieren.
//!
//! Wird von der Sequencer-Übersicht per langem Druck auf eine Baustein-Kachel
//! geöffnet (kurzer Tap dort löst weiter nur aus). Reines Overlay über der
//! ganzen Fläche — „← Zurück" schließt es wieder.
//!
//! - Melodie: Piano-Roll-Grid (Zeilen = Tonhöhen um die Grundnote, Spalten =
//!   Steps). Zelle antippen → Note an diesem Step an/aus.
//! - Beat: Zeilen = Drum-Lines (mit Mute), Spalten = Steps. Zelle antippen →
//!   Step an/aus.
//! - Name antippen → Touch-Keyboard, max. 6 Zeichen.

import { Container, Graphics } from "pixi.js";
import type { Store, Block, Device } from "../state";
import { button, label } from "./widgets";
import type { TouchKeyboard } from "./keyboard";
import { PAL } from "../theme";

const DIRECTIONS = ["up", "down", "upDown", "random", "asPlayed"];
const MSG_KINDS = ["programChange", "cc", "note"];

type Send = (cmd: object) => void;

const TOP = 100;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(note: number): string {
  const octave = Math.floor(note / 12) - 1;
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${octave}`;
}

export class BlockDetailScreen {
  readonly container = new Container();
  private bg = new Graphics();
  private body = new Container();
  private popup = new Container();
  private store: Store;
  private send: Send;
  private keyboard: TouchKeyboard;
  private w = 0;
  private h = 0;
  private blockId?: string;

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

  open(blockId: string) {
    this.blockId = blockId;
    this.container.visible = true;
    this.rebuild();
  }

  close() {
    this.container.visible = false;
    this.blockId = undefined;
    this.popup.removeChildren();
  }

  private findBlockAndDevice(): { block: Block; device: Device } | undefined {
    if (!this.blockId) return undefined;
    for (const dev of this.store.project?.devices ?? []) {
      const b = dev.blocks?.find((b) => b.id === this.blockId);
      if (b) return { block: b, device: dev };
    }
    return undefined;
  }

  /** Tap → TouchKeyboard für Ganzzahl-Eingabe (0-127-Bereich o.ä.), geklemmt. */
  private editNumber(current: number, min: number, max: number, onSet: (n: number) => void) {
    this.keyboard.open(String(current), 4, (v) => {
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) onSet(Math.min(max, Math.max(min, n)));
    });
  }

  private setField(blockId: string, field: string, value: unknown) {
    this.send({ t: "block.setField", blockId, field, value });
  }

  private rebuild() {
    this.body.removeChildren();
    this.bg.clear();
    this.bg.rect(0, TOP, this.w, this.h - TOP).fill({ color: PAL.waterDeep, alpha: 0.98 });

    const back = button("← Zurück", { w: 130, h: 40, color: PAL.btnAlt, fontSize: 17 }, () => this.close());
    back.x = 16;
    back.y = TOP + 12;
    this.body.addChild(back);

    const found = this.findBlockAndDevice();
    if (!found) {
      const gone = label("Baustein nicht mehr vorhanden.", 18, PAL.textDim, "400");
      gone.x = 16;
      gone.y = TOP + 70;
      this.body.addChild(gone);
      return;
    }
    const { block, device } = found;

    const nameTxt = label(block.name || "(neu)", 26, PAL.text, "700");
    nameTxt.x = 160;
    nameTxt.y = TOP + 14;
    nameTxt.eventMode = "static";
    nameTxt.cursor = "pointer";
    nameTxt.on("pointertap", () =>
      this.keyboard.open(block.name, 6, (v) => {
        if (v) this.send({ t: "block.rename", blockId: block.id, name: v });
      }),
    );
    this.body.addChild(nameTxt);

    const typeTxt = label(block.type.toUpperCase(), 13, PAL.textDim, "600");
    typeTxt.x = 160;
    typeTxt.y = TOP + 50;
    this.body.addChild(typeTxt);

    // Kanal-Override — gilt für jeden Bausteintyp. Zyklisch: geerbt (Lane/Device)
    // → 1 → 2 → … → 16 → geerbt.
    const chLabel = block.channel ? `Kanal ${block.channel}` : `Kanal: Gerät (${device.channel})`;
    const chBtn = button(chLabel, { w: 168, h: 30, color: PAL.btn, fontSize: 13 }, () => {
      const next = block.channel === undefined ? 1 : block.channel >= 16 ? undefined : block.channel + 1;
      this.setField(block.id, "channel", next ?? null);
    });
    chBtn.x = 300;
    chBtn.y = TOP + 46;
    this.body.addChild(chBtn);

    switch (block.type) {
      case "melody":
        this.melodyEditor(block);
        break;
      case "beat":
        this.beatEditor(block);
        break;
      case "chord":
        this.chordEditor(block);
        break;
      case "arp":
        this.arpEditor(block);
        break;
      case "cc":
        this.ccEditor(block);
        break;
      case "programChange":
        this.programChangeEditor(block);
        break;
      case "patternShift":
        this.patternShiftEditor(block);
        break;
    }
  }

  // ── Melodie: Piano-Roll ─────────────────────────────────────────────────

  private melodyEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const base = block.baseNote ?? 60;
    const low = base - 6;
    const high = base + 18; // 2 Oktaven Ambitus um die Grundnote
    const notes = block.notes ?? [];

    const baseBtn = button(`Grundton ${noteName(base)}`, { w: 150, h: 30, color: PAL.btn, fontSize: 13 }, () =>
      this.editNumber(base, 0, 127, (n) => this.setField(block.id, "baseNote", n)),
    );
    baseBtn.x = 480;
    baseBtn.y = TOP + 46;
    this.body.addChild(baseBtn);

    const cellW = 34;
    const cellH = 22;
    const gridX = 90;
    const gridY = TOP + 90;

    const hasNote = (step: number, note: number) =>
      notes.some((n) => n.step === step && n.note === note);

    let row = 0;
    for (let note = high; note >= low; note--) {
      const y = gridY + row * cellH;
      const isC = ((note % 12) + 12) % 12 === 0;
      const rowBg = new Graphics();
      rowBg.rect(gridX, y, totalSteps * cellW, cellH).fill({
        color: isC ? PAL.panelDeep : PAL.panel,
        alpha: 0.4,
      });
      this.body.addChild(rowBg);

      const nameTxt = label(noteName(note), 11, note === base ? PAL.white : PAL.textDim, note === base ? "700" : "400");
      nameTxt.x = 8;
      nameTxt.y = y + 3;
      this.body.addChild(nameTxt);

      for (let step = 0; step < totalSteps; step++) {
        const on = hasNote(step, note);
        const cell = new Graphics();
        const draw = (active: boolean) => {
          cell.clear();
          cell.rect(0, 0, cellW - 2, cellH - 2).fill({ color: active ? PAL.btnActive : PAL.btn, alpha: active ? 1 : 0.5 });
          cell.rect(0, 0, cellW - 2, cellH - 2).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
        };
        draw(on);
        cell.x = gridX + step * cellW;
        cell.y = y;
        cell.eventMode = "static";
        cell.cursor = "pointer";
        cell.on("pointertap", () => {
          this.send({ t: "melody.toggleNote", blockId: block.id, step, note });
        });
        this.body.addChild(cell);
      }
      row++;
    }

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);
  }

  // ── Beat: Step-Grid pro Line ─────────────────────────────────────────────

  private beatEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const lines = block.lines ?? [];

    const cellW = 34;
    const rowH = 46;
    const gridX = 140;
    const gridY = TOP + 90;

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);

    lines.forEach((line, row) => {
      const y = gridY + row * rowH;

      const nameTxt = label(line.name, 15, line.muted ? PAL.textDim : PAL.text, "600");
      nameTxt.x = 16;
      nameTxt.y = y + 6;
      nameTxt.eventMode = "static";
      nameTxt.cursor = "pointer";
      nameTxt.on("pointertap", () =>
        this.send({ t: "beat.setLineMuted", blockId: block.id, lineId: line.id, muted: !line.muted }),
      );
      this.body.addChild(nameTxt);

      const muteHint = label(line.muted ? "MUTE" : "", 10, PAL.danger, "700");
      muteHint.x = 16;
      muteHint.y = y + 26;
      this.body.addChild(muteHint);

      for (let step = 0; step < totalSteps; step++) {
        const on = (line.steps[step]?.velocity ?? 0) > 0;
        const cell = new Graphics();
        const draw = (active: boolean) => {
          cell.clear();
          const beatMarker = step % (stepsPerBar / 4) === 0;
          cell.rect(0, 0, cellW - 2, rowH - 8).fill({
            color: active ? PAL.btnActive : beatMarker ? PAL.panelDeep : PAL.btn,
            alpha: active ? 1 : line.muted ? 0.3 : 0.55,
          });
          cell.rect(0, 0, cellW - 2, rowH - 8).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
        };
        draw(on);
        cell.x = gridX + step * cellW;
        cell.y = y;
        cell.eventMode = "static";
        cell.cursor = "pointer";
        cell.on("pointertap", () =>
          this.send({ t: "beat.toggleStep", blockId: block.id, lineId: line.id, step }),
        );
        this.body.addChild(cell);
      }
    });
  }

  // ── Chord: Piano-Roll wie Melodie, aber mehrere Noten pro Step ──────────────

  private chordEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const base = block.baseNote ?? 60;
    const low = base - 6;
    const high = base + 18;
    const chords = block.chords ?? [];

    const baseBtn = button(`Grundton ${noteName(base)}`, { w: 150, h: 30, color: PAL.btn, fontSize: 13 }, () =>
      this.editNumber(base, 0, 127, (n) => this.setField(block.id, "baseNote", n)),
    );
    baseBtn.x = 480;
    baseBtn.y = TOP + 46;
    this.body.addChild(baseBtn);

    const cellW = 34;
    const cellH = 22;
    const gridX = 90;
    const gridY = TOP + 90;

    const hasNote = (step: number, note: number) =>
      chords.some((c) => c.step === step && c.notes.includes(note));

    let row = 0;
    for (let note = high; note >= low; note--) {
      const y = gridY + row * cellH;
      const isC = ((note % 12) + 12) % 12 === 0;
      const rowBg = new Graphics();
      rowBg.rect(gridX, y, totalSteps * cellW, cellH).fill({
        color: isC ? PAL.panelDeep : PAL.panel,
        alpha: 0.4,
      });
      this.body.addChild(rowBg);

      const nameTxt = label(noteName(note), 11, note === base ? PAL.white : PAL.textDim, note === base ? "700" : "400");
      nameTxt.x = 8;
      nameTxt.y = y + 3;
      this.body.addChild(nameTxt);

      for (let step = 0; step < totalSteps; step++) {
        const on = hasNote(step, note);
        const cell = new Graphics();
        cell.rect(0, 0, cellW - 2, cellH - 2).fill({ color: on ? PAL.btnActive : PAL.btn, alpha: on ? 1 : 0.5 });
        cell.rect(0, 0, cellW - 2, cellH - 2).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
        cell.x = gridX + step * cellW;
        cell.y = y;
        cell.eventMode = "static";
        cell.cursor = "pointer";
        cell.on("pointertap", () => {
          this.send({ t: "chord.toggleNote", blockId: block.id, step, note });
        });
        this.body.addChild(cell);
      }
      row++;
    }

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);
  }

  // ── Arp: Notenvorrat-Strip + Parameter ──────────────────────────────────────

  private arpEditor(block: Block) {
    const base = block.baseNote ?? 60;
    const low = base - 12;
    const high = base + 12; // 2 Oktaven Vorrat
    const chordNotes = block.chordNotes ?? [];
    const direction = block.direction ?? "up";
    const gateSteps = block.gateSteps ?? 1;
    const rateSteps = block.rateSteps ?? 1;
    const velocity = block.velocity ?? 100;

    const cellW = 34;
    const cellH = 26;
    const gridX = 90;
    const gridY = TOP + 90;

    const noteTxt = label("Notenvorrat (antippen = an/aus):", 13, PAL.textDim, "400");
    noteTxt.x = gridX;
    noteTxt.y = gridY - 22;
    this.body.addChild(noteTxt);

    let col = 0;
    for (let note = low; note <= high; note++) {
      const on = chordNotes.includes(note);
      const cell = new Graphics();
      cell.rect(0, 0, cellW - 2, cellH - 2).fill({ color: on ? PAL.btnActive : PAL.btn, alpha: on ? 1 : 0.5 });
      cell.rect(0, 0, cellW - 2, cellH - 2).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
      cell.x = gridX + col * cellW;
      cell.y = gridY;
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () => this.send({ t: "arp.toggleNote", blockId: block.id, note }));
      this.body.addChild(cell);

      const nameTxt = label(noteName(note), 9, note === base ? PAL.white : PAL.textDim, note === base ? "700" : "400");
      nameTxt.x = gridX + col * cellW + 2;
      nameTxt.y = gridY + cellH + 2;
      this.body.addChild(nameTxt);
      col++;
    }

    const paramY = gridY + cellH + 30;
    const baseBtn = button(`Grundton ${noteName(base)}`, { w: 150, h: 34, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(base, 0, 127, (n) => this.setField(block.id, "baseNote", n)),
    );
    baseBtn.x = gridX;
    baseBtn.y = paramY;
    this.body.addChild(baseBtn);

    const dirBtn = button(`Richtung: ${direction}`, { w: 170, h: 34, color: PAL.btn, fontSize: 14 }, () => {
      const next = DIRECTIONS[(DIRECTIONS.indexOf(direction) + 1) % DIRECTIONS.length];
      this.setField(block.id, "direction", next);
    });
    dirBtn.x = gridX + 160;
    dirBtn.y = paramY;
    this.body.addChild(dirBtn);

    const gateBtn = button(`Gate ${gateSteps}`, { w: 120, h: 34, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(gateSteps, 1, 64, (n) => this.setField(block.id, "gateSteps", n)),
    );
    gateBtn.x = gridX + 340;
    gateBtn.y = paramY;
    this.body.addChild(gateBtn);

    const rateBtn = button(`Rate ${rateSteps}`, { w: 120, h: 34, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(rateSteps, 1, 64, (n) => this.setField(block.id, "rateSteps", n)),
    );
    rateBtn.x = gridX + 470;
    rateBtn.y = paramY;
    this.body.addChild(rateBtn);

    const velBtn = button(`Vel ${velocity}`, { w: 120, h: 34, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(velocity, 1, 127, (n) => this.setField(block.id, "velocity", n)),
    );
    velBtn.x = gridX + 600;
    velBtn.y = paramY;
    this.body.addChild(velBtn);
  }

  // ── CC-Automation: Stepped-Layer als Balken-Grid ─────────────────────────────

  private ccEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const ccNumber = block.ccNumber ?? 74;
    const outMin = block.outMin ?? 0;
    const outMax = block.outMax ?? 127;
    const layer = (block.layers ?? []).find((l) => l.kind === "stepped");
    const values = layer?.values ?? new Array(totalSteps).fill(0);

    const gridX = 90;
    const gridY = TOP + 130;
    const cellW = 34;
    const rowH = 100;

    const ccBtn = button(`CC ${ccNumber}`, { w: 110, h: 30, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(ccNumber, 0, 127, (n) => this.setField(block.id, "ccNumber", n)),
    );
    ccBtn.x = gridX;
    ccBtn.y = TOP + 80;
    this.body.addChild(ccBtn);

    const minBtn = button(`Min ${outMin}`, { w: 100, h: 30, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(outMin, 0, 127, (n) => this.setField(block.id, "outMin", n)),
    );
    minBtn.x = gridX + 120;
    minBtn.y = TOP + 80;
    this.body.addChild(minBtn);

    const maxBtn = button(`Max ${outMax}`, { w: 100, h: 30, color: PAL.btn, fontSize: 14 }, () =>
      this.editNumber(outMax, 0, 127, (n) => this.setField(block.id, "outMax", n)),
    );
    maxBtn.x = gridX + 230;
    maxBtn.y = TOP + 80;
    this.body.addChild(maxBtn);

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);

    const rowBg = new Graphics();
    rowBg.rect(gridX, gridY, totalSteps * cellW, rowH).fill({ color: PAL.panel, alpha: 0.4 });
    this.body.addChild(rowBg);

    for (let step = 0; step < totalSteps; step++) {
      const v = values[step] ?? 0;
      const barH = Math.max(2, (v / 127) * (rowH - 4));
      const cell = new Graphics();
      cell.rect(0, rowH - barH, cellW - 2, barH).fill({ color: PAL.btnActive, alpha: 0.9 });
      cell.rect(0, 0, cellW - 2, rowH).stroke({ color: PAL.line, width: 1, alpha: 0.2 });
      cell.x = gridX + step * cellW;
      cell.y = gridY;
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () =>
        this.editNumber(v, 0, 127, (n) => this.send({ t: "cc.setStepValue", blockId: block.id, step, value: n })),
      );
      this.body.addChild(cell);

      const vt = label(`${v}`, 9, PAL.textDim, "400");
      vt.x = gridX + step * cellW + 2;
      vt.y = gridY + rowH + 2;
      this.body.addChild(vt);
    }
  }

  // ── Program-Change: Step-Reihe mit Programm-Nummer je Event ──────────────────

  private programChangeEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const events = block.events ?? [];

    const gridX = 90;
    const gridY = TOP + 90;
    const cellW = 46;
    const cellH = 40;

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);

    for (let step = 0; step < totalSteps; step++) {
      const evt = events.find((e) => e.atStep === step);
      const cell = new Graphics();
      cell.rect(0, 0, cellW - 2, cellH - 2).fill({ color: evt ? PAL.btnActive : PAL.btn, alpha: evt ? 1 : 0.5 });
      cell.rect(0, 0, cellW - 2, cellH - 2).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
      cell.x = gridX + step * cellW;
      cell.y = gridY;
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () =>
        this.editNumber(evt?.program ?? 0, 0, 127, (n) =>
          this.send({ t: "programChange.setEvent", blockId: block.id, step, program: n }),
        ),
      );
      let holdTimer: number | undefined;
      cell.on("pointerdown", () => {
        if (!evt) return;
        holdTimer = window.setTimeout(
          () => this.send({ t: "programChange.setEvent", blockId: block.id, step, program: null }),
          500,
        );
      });
      const clearHold = () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = undefined;
        }
      };
      cell.on("pointerup", clearHold);
      cell.on("pointerupoutside", clearHold);
      this.body.addChild(cell);

      if (evt) {
        const t = label(`PC${evt.program}`, 10, PAL.ink, "700");
        t.anchor.set(0.5);
        t.x = gridX + step * cellW + (cellW - 2) / 2;
        t.y = gridY + (cellH - 2) / 2;
        this.body.addChild(t);
      }
    }
  }

  // ── Pattern-Shift: Step-Reihe mit MIDI-Nachricht je Event ────────────────────

  private patternShiftEditor(block: Block) {
    const stepsPerBar = block.stepsPerBar ?? 16;
    const bars = block.lengthBars ?? 1;
    const totalSteps = stepsPerBar * bars;
    const messages = block.messages ?? [];

    const gridX = 90;
    const gridY = TOP + 90;
    const cellW = 46;
    const cellH = 40;

    this.stepRuler(gridX, gridY - 18, cellW, totalSteps, stepsPerBar);

    for (let step = 0; step < totalSteps; step++) {
      const msg = messages.find((m) => m.atStep === step);
      const cell = new Graphics();
      cell.rect(0, 0, cellW - 2, cellH - 2).fill({ color: msg ? PAL.btnActive : PAL.btn, alpha: msg ? 1 : 0.5 });
      cell.rect(0, 0, cellW - 2, cellH - 2).stroke({ color: PAL.line, width: 1, alpha: 0.25 });
      cell.x = gridX + step * cellW;
      cell.y = gridY;
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () => this.openPatternMessagePicker(block.id, step, msg));
      let holdTimer: number | undefined;
      cell.on("pointerdown", () => {
        if (!msg) return;
        holdTimer = window.setTimeout(
          () => this.send({ t: "patternShift.setEvent", blockId: block.id, step, kind: null }),
          500,
        );
      });
      const clearHold = () => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = undefined;
        }
      };
      cell.on("pointerup", clearHold);
      cell.on("pointerupoutside", clearHold);
      this.body.addChild(cell);

      if (msg) {
        const short = msg.kind === "programChange" ? `PC${msg.data1}` : msg.kind === "cc" ? `CC${msg.data1}` : `N${msg.data1}`;
        const t = label(short, 10, PAL.ink, "700");
        t.anchor.set(0.5);
        t.x = gridX + step * cellW + (cellW - 2) / 2;
        t.y = gridY + (cellH - 2) / 2;
        this.body.addChild(t);
      }
    }
  }

  /** Popup: Nachrichtentyp wählen, dann data1 (+ data2 bei cc/note) per Keyboard. */
  private openPatternMessagePicker(
    blockId: string,
    step: number,
    existing: { kind: string; data1: number; data2?: number } | undefined,
  ) {
    this.popup.removeChildren();
    const overlay = new Graphics();
    overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.7 });
    overlay.eventMode = "static";
    overlay.on("pointertap", () => this.popup.removeChildren());
    this.popup.addChild(overlay);

    const boxW = Math.min(420, this.w - 40);
    const boxH = 220;
    const box = new Container();
    box.x = (this.w - boxW) / 2;
    box.y = (this.h - boxH) / 2;
    const bg = new Graphics();
    bg.roundRect(0, 0, boxW, boxH, 18).fill({ color: PAL.panel, alpha: 0.98 });
    bg.roundRect(0, 0, boxW, boxH, 18).stroke({ color: PAL.line, width: 2, alpha: 0.35 });
    box.addChild(bg);

    const title = label("Nachrichtentyp wählen", 20, PAL.text, "700");
    title.x = 20;
    title.y = 16;
    box.addChild(title);

    MSG_KINDS.forEach((kind, i) => {
      const b = button(kind, { w: boxW - 40, h: 50, color: PAL.btn, fontSize: 17 }, () => {
        this.popup.removeChildren();
        const askData1 = (data1: number) => {
          this.editNumber(data1, 0, 127, (d1) => {
            if (kind === "programChange") {
              this.send({ t: "patternShift.setEvent", blockId, step, kind, data1: d1 });
            } else {
              this.editNumber(existing?.data2 ?? 127, 0, 127, (d2) =>
                this.send({ t: "patternShift.setEvent", blockId, step, kind, data1: d1, data2: d2 }),
              );
            }
          });
        };
        askData1(existing?.kind === kind ? existing.data1 : 0);
      });
      b.x = 20;
      b.y = 58 + i * 58;
      box.addChild(b);
    });

    this.popup.addChild(box);
  }

  private stepRuler(gridX: number, y: number, cellW: number, totalSteps: number, stepsPerBar: number) {
    for (let step = 0; step < totalSteps; step++) {
      if (step % (stepsPerBar / 4) !== 0) continue;
      const t = label(`${step + 1}`, 10, PAL.textDim, "400");
      t.x = gridX + step * cellW + 4;
      t.y = y;
      this.body.addChild(t);
    }
  }
}
