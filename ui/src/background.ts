//! Pixi-Hintergrund: nur die Unterwasser-Szene + der Ripple-Layer. Läuft in
//! einem eigenen, nicht-interaktiven Canvas hinter der React-Oberfläche (die
//! das eigentliche "Frontend" ist — siehe docs/ARCHITECTURE.md §2/§6). Das
//! Canvas hat `pointer-events: none`, damit alle Touches ungehindert bis zur
//! React-Ebene durchgereicht werden; Pixi's eigenes Interaktionssystem wird
//! hier daher nicht gebraucht.

import { Application } from "pixi.js";
import { UnderwaterScene } from "./scene/underwater";
import { wireGlobalRipples } from "./ui/ripple";

export async function mountBackground(host: HTMLElement) {
  const app = new Application();
  await app.init({
    background: 0x000000,
    resizeTo: window,
    antialias: false, // harte Kanten / Pixel-Look
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  app.canvas.style.pointerEvents = "none";
  host.appendChild(app.canvas);

  const scene = new UnderwaterScene();
  app.stage.addChild(scene.container);
  wireGlobalRipples(app.stage);

  const resize = () => scene.resize(app.screen.width, app.screen.height);
  resize();
  window.addEventListener("resize", resize);

  app.ticker.add((ticker) => scene.update(ticker));
}
