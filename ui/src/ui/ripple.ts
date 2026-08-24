//! Water-droplet ripple: an expanding, fading ring at the touch point,
//! matching the underwater look (soap-bubble/glow feedback per the
//! architecture doc). Wired globally once (see `wireGlobalRipples` in
//! background.ts) — every DOM element that follows the app-wide "tappable"
//! convention (`cursor: pointer`) ripples automatically on pointerdown, so
//! no individual React button/tile/cell needs to call this itself.
//!
//! The ripple itself still draws into the Pixi background layer (a stacked
//! particle-style effect is cheap in WebGL and awkward in DOM/CSS), but the
//! trigger is a plain `window` pointerdown listener — the React UI sits in
//! its own DOM layer above the (pointer-events: none) background canvas, so
//! Pixi's own interaction system is never involved.

import { Container, Graphics } from "pixi.js";
import { PAL } from "../theme";

const DURATION_MS = 550;
const MAX_RADIUS = 46;

let layer: Container | null = null;

/** Spawns one ripple at stage-global coordinates (x, y). */
export function spawnRipple(x: number, y: number, color: number = PAL.white) {
  if (!layer) return;
  const g = new Graphics();
  layer.addChild(g);
  const start = performance.now();

  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / DURATION_MS);
    const r = 6 + t * MAX_RADIUS;
    const alpha = (1 - t) * 0.55;
    g.clear();
    g.circle(x, y, r).stroke({ color, width: 2 + (1 - t) * 2, alpha });
    g.circle(x, y, r * 0.5).fill({ color, alpha: alpha * 0.3 });
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      g.destroy();
    }
  };
  requestAnimationFrame(tick);
}

/**
 * Attaches a single `window` pointerdown listener — every tap that lands on
 * a `cursor: pointer` DOM element anywhere (buttons, tiles, grid cells,
 * keyboard keys, …) ripples, without touching each call site. Plain
 * background drag/pan surfaces are excluded on purpose: by convention they
 * never set `cursor: pointer`.
 */
export function wireGlobalRipples(bgStage: Container) {
  layer = new Container();
  layer.eventMode = "none"; // never itself a touch target
  bgStage.addChild(layer);

  window.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (target && getComputedStyle(target).cursor === "pointer") {
      spawnRipple(e.clientX, e.clientY);
    }
  });
}
