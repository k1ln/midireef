//! Wiederverwendbare Touch-Widgets (Buttons, Pill-Toggles) im Schwarzweiß-Look.

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { PAL } from "../theme";

export function label(
  text: string,
  size: number,
  color: number,
  weight: "400" | "600" | "700" = "600",
): Text {
  return new Text({
    text,
    style: new TextStyle({
      fill: color,
      fontSize: size,
      fontFamily: "system-ui, sans-serif",
      fontWeight: weight,
    }),
  });
}

export interface ButtonOpts {
  w: number;
  h: number;
  color?: number;
  fontSize?: number;
  textColor?: number;
}

export function button(
  text: string,
  opts: ButtonOpts,
  onTap: () => void,
): Container {
  const { w, h, color = PAL.btn, fontSize = 20, textColor = PAL.text } = opts;
  const c = new Container();
  const g = new Graphics();
  g.roundRect(0, 0, w, h, 12).fill({ color, alpha: 0.9 });
  g.roundRect(0, 0, w, h, 12).stroke({ color: PAL.line, width: 1.5, alpha: 0.3 });
  c.addChild(g);

  const t = label(text, fontSize, textColor, "600");
  t.anchor.set(0.5);
  t.x = w / 2;
  t.y = h / 2;
  c.addChild(t);

  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointertap", () => {
    c.alpha = 0.55;
    setTimeout(() => (c.alpha = 1), 90);
    onTap();
  });
  (c as any).__text = t;
  return c;
}

/** Kleiner runder An/Aus-Toggle mit Buchstabe (E/M/S). Aktiv = weiß. */
export function pillToggle(
  letter: string,
  active: boolean,
  onTap: () => void,
): Container {
  const c = new Container();
  const size = 40;
  const g = new Graphics();
  const draw = (on: boolean) => {
    g.clear();
    g.roundRect(0, 0, size, size, 10).fill({
      color: on ? PAL.btnActive : PAL.btn,
      alpha: on ? 1 : 0.85,
    });
    g.roundRect(0, 0, size, size, 10).stroke({
      color: PAL.line,
      width: 1.5,
      alpha: on ? 0.7 : 0.25,
    });
  };
  draw(active);
  c.addChild(g);

  const t = label(letter, 18, on2col(active), "700");
  t.anchor.set(0.5);
  t.x = size / 2;
  t.y = size / 2;
  c.addChild(t);

  let state = active;
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointertap", () => {
    state = !state;
    draw(state);
    t.style.fill = on2col(state);
    onTap();
  });
  return c;
}

function on2col(on: boolean): number {
  return on ? PAL.ink : PAL.textDim;
}
