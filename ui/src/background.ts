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
    // Interne Auflösung bewusst UNTER der Anzeige halten: jeder (füllraten-
    // schwere) Shader-Pass verarbeitet dann deutlich weniger Fragmente. Der
    // Pixelate-Look kaschiert das Hochskalieren, daher praktisch kostenlos.
    // 0.75 ≈ 44 % weniger Fragmente pro Pass als natives 1.0.
    resolution: Math.min(window.devicePixelRatio || 1, 0.75),
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

  // Umgebungs-Animation auf 30 fps deckeln: halbiert die (füllraten-schwere)
  // Shader-Last auf schwacher Hardware wie dem Raspberry Pi und passt zum
  // Pixel-Look. Touch-Ripples laufen über ihre eigene rAF-Schleife und bleiben
  // davon unberührt flüssig.
  app.ticker.maxFPS = 30;

  app.ticker.add((ticker) => scene.update(ticker));
}
