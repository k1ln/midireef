//! Transport-Leiste (oben, eine Reihe): Play ▶, Stop ■, SQ (Sequencer),
//! Start-Symbol (⌂), dann BPM −/+ (mit Auto-Repeat beim Halten) und Position.

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { TransportState } from "../net";
import { PAL } from "../theme";

const BAR_H = 88;
const BTN = 60;
const GAP = 10;

type CommandFn = (cmd: object) => void;
type NavFn = (view: "start" | "seq") => void;

interface ButtonOpts {
  repeat?: boolean; // hält den Tap gedrückt und wiederholt ihn (BPM-Dauerlauf)
  fontSize?: number;
}

function makeButton(
  labelText: string,
  w: number,
  color: number,
  onTap: () => void,
  opts: ButtonOpts = {},
): Container {
  const c = new Container();
  const g = new Graphics();
  g.roundRect(0, 0, w, BTN, 14).fill({ color, alpha: 0.9 });
  g.roundRect(0, 0, w, BTN, 14).stroke({ color: PAL.line, width: 1.5, alpha: 0.3 });
  c.addChild(g);

  const txt = new Text({
    text: labelText,
    style: new TextStyle({
      fill: PAL.text,
      fontSize: opts.fontSize ?? 24,
      fontFamily: "system-ui, sans-serif",
      fontWeight: "600",
    }),
  });
  txt.anchor.set(0.5);
  txt.x = w / 2;
  txt.y = BTN / 2;
  c.addChild(txt);

  c.eventMode = "static";
  c.cursor = "pointer";

  if (opts.repeat) {
    // Halten → sofort + nach kurzer Verzögerung fortlaufend wiederholen.
    let hold = 0;
    let rep = 0;
    const stop = () => {
      window.clearTimeout(hold);
      window.clearInterval(rep);
      c.alpha = 1;
    };
    c.on("pointerdown", () => {
      c.alpha = 0.6;
      onTap();
      hold = window.setTimeout(() => {
        rep = window.setInterval(onTap, 70);
      }, 350);
    });
    c.on("pointerup", stop);
    c.on("pointerupoutside", stop);
  } else {
    c.on("pointertap", () => {
      c.alpha = 0.6;
      setTimeout(() => (c.alpha = 1), 90);
      onTap();
    });
  }

  return c;
}

export class TransportBar {
  readonly container = new Container();
  private bg = new Graphics();
  private playBtn: Container;
  private stopBtn: Container;
  private navSeq: Container;
  private navStart: Container;
  private saveBtn: Container;
  private bpmText: Text;
  private posText: Text;
  private portText: Text;
  private send: CommandFn;

  constructor(send: CommandFn, onNav: NavFn) {
    this.send = send;
    this.container.addChild(this.bg);

    let x = 16;
    const y = 14;

    // ▶ Play (nur Dreieck)
    this.playBtn = makeButton("▶", BTN, PAL.btn, () =>
      this.send({ t: "transport.play" }),
    );
    this.playBtn.x = x;
    this.playBtn.y = y;
    this.container.addChild(this.playBtn);
    x += BTN + GAP;

    // ■ Stop (beendet + räumt hängende Noten auf)
    this.stopBtn = makeButton("■", BTN, PAL.btn, () => {
      this.send({ t: "transport.stop" });
      this.send({ t: "transport.panic" });
    });
    this.stopBtn.x = x;
    this.stopBtn.y = y;
    this.container.addChild(this.stopBtn);
    x += BTN + GAP + 6;

    // SQ – Sequencer-Ansicht
    this.navSeq = makeButton("SQ", BTN, PAL.btn, () => onNav("seq"), {
      fontSize: 20,
    });
    this.navSeq.x = x;
    this.navSeq.y = y;
    this.container.addChild(this.navSeq);
    x += BTN + GAP;

    // ⌂ Start – Startbildschirm
    this.navStart = makeButton("⌂", BTN, PAL.btn, () => onNav("start"), {
      fontSize: 26,
    });
    this.navStart.x = x;
    this.navStart.y = y;
    this.container.addChild(this.navStart);
    x += BTN + GAP;

    // Speichern – sichert das Projekt dauerhaft auf den Server (data/projects/*.json).
    this.saveBtn = makeButton("SAVE", 84, PAL.btn, () => this.send({ t: "project.save" }), {
      fontSize: 16,
    });
    this.saveBtn.x = x;
    this.saveBtn.y = y;
    this.container.addChild(this.saveBtn);
    x += 84 + GAP + 16;

    // − BPM
    const minus = makeButton("−", 56, PAL.btn, () => this.nudgeBpm(-1), {
      repeat: true,
    });
    minus.x = x;
    minus.y = y;
    this.container.addChild(minus);
    x += 56 + GAP;

    this.bpmText = new Text({
      text: "120 BPM",
      style: new TextStyle({
        fill: PAL.text,
        fontSize: 24,
        fontFamily: "system-ui, sans-serif",
        fontWeight: "700",
      }),
    });
    this.bpmText.anchor.set(0.5);
    this.bpmText.x = x + 60;
    this.bpmText.y = 44;
    this.container.addChild(this.bpmText);
    x += 120 + GAP;

    // + BPM (Halten → läuft hoch)
    const plus = makeButton("+", 56, PAL.btn, () => this.nudgeBpm(1), {
      repeat: true,
    });
    plus.x = x;
    plus.y = y;
    this.container.addChild(plus);

    this.posText = new Text({
      text: "1 : 1",
      style: new TextStyle({
        fill: PAL.white,
        fontSize: 30,
        fontFamily: "ui-monospace, monospace",
        fontWeight: "700",
      }),
    });
    this.posText.anchor.set(1, 0.5);
    this.posText.y = 34;
    this.container.addChild(this.posText);

    this.portText = new Text({
      text: "MIDI: —",
      style: new TextStyle({
        fill: PAL.textDim,
        fontSize: 14,
        fontFamily: "system-ui, sans-serif",
      }),
    });
    this.portText.anchor.set(1, 0.5);
    this.portText.y = 64;
    this.container.addChild(this.portText);
  }

  /** Hebt den aktiven Navigations-Button hervor. */
  setView(view: "start" | "seq") {
    this.navSeq.alpha = view === "seq" ? 1 : 0.55;
    this.navStart.alpha = view === "start" ? 1 : 0.55;
  }

  private nudgeBpm(delta: number) {
    const cur = parseInt(this.bpmText.text) || 120;
    const next = Math.min(300, Math.max(20, cur + delta));
    this.bpmText.text = `${next} BPM`;
    this.send({ t: "transport.setBpm", bpm: next });
  }

  resize(w: number) {
    this.bg.clear();
    this.bg.roundRect(0, 0, w, BAR_H, 0).fill({ color: PAL.panel, alpha: 0.82 });
    this.bg
      .moveTo(0, BAR_H)
      .lineTo(w, BAR_H)
      .stroke({ color: PAL.line, width: 2, alpha: 0.25 });
    this.posText.x = w - 24;
    this.portText.x = w - 24;
  }

  applyTransport(t: TransportState) {
    this.playBtn.alpha = t.playing ? 1 : 0.7;
    this.stopBtn.alpha = t.playing ? 0.7 : 1;
    this.bpmText.text = `${Math.round(t.bpm)} BPM`;
    this.posText.text = `${t.bar} : ${t.beat}`;
  }

  applyPorts(outputs: string[]) {
    this.portText.text =
      outputs.length > 0 ? `MIDI: ${outputs.length} Out` : "MIDI: keine Ports";
  }
}
