//! On-Screen Touch-Keyboard (kein OS-Keyboard). Öffnet als Overlay, gibt den
//! eingegebenen Text per Callback zurück (oder null bei Abbruch).

import { Container, Graphics, Text } from "pixi.js";
import { button, label } from "./widgets";
import { PAL } from "../theme";

const ROWS = [
  "1234567890",
  "qwertzuiop",
  "asdfghjkl",
  "yxcvbnm",
];

export class TouchKeyboard {
  readonly container = new Container();
  private overlay = new Graphics();
  private valueText: Text;
  private value = "";
  private maxLen = 32;
  private done?: (v: string | null) => void;
  private w = 0;
  private h = 0;
  private keysLayer = new Container();

  constructor() {
    this.container.visible = false;
    this.container.addChild(this.overlay);
    this.container.addChild(this.keysLayer);
    this.valueText = label("", 34, PAL.text, "700");
    this.container.addChild(this.valueText);
  }

  open(current: string, maxLen: number, done: (v: string | null) => void) {
    this.value = current;
    this.maxLen = maxLen;
    this.done = done;
    this.container.visible = true;
    this.build();
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (this.container.visible) this.build();
  }

  private close(result: string | null) {
    this.container.visible = false;
    const cb = this.done;
    this.done = undefined;
    cb?.(result);
  }

  private build() {
    this.overlay.clear();
    this.overlay.rect(0, 0, this.w, this.h).fill({ color: PAL.black, alpha: 0.85 });

    const kbH = Math.min(this.h * 0.62, 420);
    const kbY = this.h - kbH;
    this.overlay
      .roundRect(0, kbY - 8, this.w, kbH + 8, 18)
      .fill({ color: PAL.panel, alpha: 0.97 });

    this.valueText.text = this.value || " ";
    this.valueText.anchor.set(0.5);
    this.valueText.x = this.w / 2;
    this.valueText.y = kbY - 48;

    this.keysLayer.removeChildren();
    const pad = 8;
    const cols = 10;
    const keyW = Math.min(74, (this.w - pad * (cols + 1)) / cols);
    const keyH = Math.min(64, (kbH - pad * 6) / 5);
    const startY = kbY + pad;

    ROWS.forEach((row, r) => {
      const rowLen = row.length;
      const rowW = rowLen * keyW + (rowLen - 1) * pad;
      const startX = (this.w - rowW) / 2;
      for (let i = 0; i < rowLen; i++) {
        const ch = row[i];
        const b = button(
          ch,
          { w: keyW, h: keyH, color: PAL.btn, fontSize: 26 },
          () => this.type(ch),
        );
        b.x = startX + i * (keyW + pad);
        b.y = startY + r * (keyH + pad);
        this.keysLayer.addChild(b);
      }
    });

    // Aktionsreihe: Space, ⌫, Abbrechen, OK
    const actY = startY + 4 * (keyH + pad);
    const space = button(
      "Leer",
      { w: this.w * 0.32, h: keyH, color: PAL.btn, fontSize: 22 },
      () => this.type(" "),
    );
    space.x = this.w / 2 - this.w * 0.16;
    space.y = actY;
    this.keysLayer.addChild(space);

    const back = button(
      "⌫",
      { w: keyW * 1.4, h: keyH, color: PAL.btnAlt, fontSize: 26 },
      () => {
        this.value = this.value.slice(0, -1);
        this.valueText.text = this.value || " ";
      },
    );
    back.x = space.x - keyW * 1.4 - pad;
    back.y = actY;
    this.keysLayer.addChild(back);

    const cancel = button(
      "Abbr.",
      { w: keyW * 1.6, h: keyH, color: PAL.danger, fontSize: 20 },
      () => this.close(null),
    );
    cancel.x = space.x + this.w * 0.32 + pad;
    cancel.y = actY;
    this.keysLayer.addChild(cancel);

    const ok = button(
      "OK",
      { w: keyW * 1.6, h: keyH, color: PAL.btnActive, fontSize: 24, textColor: PAL.ink },
      () => this.close(this.value.trim()),
    );
    ok.x = cancel.x + keyW * 1.6 + pad;
    ok.y = actY;
    this.keysLayer.addChild(ok);
  }

  private type(ch: string) {
    if (this.value.length >= this.maxLen) return;
    this.value += ch;
    this.valueText.text = this.value || " ";
  }
}
