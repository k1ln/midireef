//! Pixi-Hintergrund: nur die Unterwasser-Szene. Läuft in
//! einem eigenen, nicht-interaktiven Canvas hinter der React-Oberfläche (die
//! das eigentliche "Frontend" ist — siehe docs/ARCHITECTURE.md §2/§6). Das
//! Canvas hat `pointer-events: none`, damit alle Touches ungehindert bis zur
//! React-Ebene durchgereicht werden; Pixi's eigenes Interaktionssystem wird
//! hier daher nicht gebraucht.

import { Application } from "pixi.js";
import { UnderwaterScene } from "./scene/underwater";
import { getUiScale, UI_SCALE_EVENT } from "./app/uiScale";
import { getBgConfig, bgEnabled, BG_CONFIG_EVENT } from "./app/bgConfig";

export async function mountBackground(host: HTMLElement) {
  const app = new Application();
  await app.init({
    background: 0x000000,
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

  // Nutzer-Konfiguration lokal halten (nicht bei jedem Noten-Event neu aus
  // localStorage lesen) und bei BG_CONFIG_EVENT auffrischen.
  let cfg = getBgConfig();

  const scene = new UnderwaterScene(cfg);
  app.stage.addChild(scene.container);

  // Die App skaliert ihre GESAMTE Oberfläche über CSS `zoom` auf <html>
  // (s. uiScale.ts) — das streckt/staucht auch dieses Canvas mit. Würden wir
  // in Fenstergröße rendern, bliebe bei scale < 1 ein Rand ums Canvas frei.
  // Also in der *logischen* Größe (Fenster / Skalierung) rendern: nach dem
  // `zoom` landet das Canvas exakt auf dem Viewport.
  const resize = () => {
    const scale = getUiScale();
    app.renderer.resize(window.innerWidth / scale, window.innerHeight / scale);
    scene.resize(app.screen.width, app.screen.height);
    // Bei angehaltener Szene rendert der Ticker nicht mehr nach — nach dem
    // Resize einmal von Hand einen schwarzen Frame zeichnen.
    if (!bgEnabled(cfg)) app.renderer.render(app.stage);
  };
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener(UI_SCALE_EVENT, resize);

  // Umgebungs-Animation auf die in den Einstellungen gewählte Bildrate
  // deckeln: senkt die (füllraten-schwere) Shader-Last auf schwacher
  // Hardware wie dem Raspberry Pi und passt zum Pixel-Look. Die Tipp-
  // Rückmeldung (ui/ripple.ts) hängt nicht an diesem Ticker und bleibt davon
  // unberührt flüssig.
  app.ticker.maxFPS = cfg.fps;

  app.ticker.add((ticker) => scene.update(ticker));

  // ── Preset "off" = Szene aus ──────────────────────────────────────────
  // Aus: Szene ausblenden, EINEN schwarzen Frame zeichnen (Clear-Farbe
  // 0x000000) und dann den Ticker ganz anhalten — kein Render-, kein Shader-
  // Pass mehr. An: Szene wieder zeigen, Ticker läuft weiter (Pixi rendert
  // über denselben Ticker, s. TickerPlugin).
  const applyEnabled = (on: boolean) => {
    scene.container.visible = on;
    if (on) {
      app.ticker.start();
    } else {
      app.renderer.render(app.stage);
      app.ticker.stop();
    }
  };
  applyEnabled(bgEnabled(cfg));

  // Einstellungen geändert (ProjectSettings → Background): Kreaturenzahl live
  // nachziehen und ggf. Ticker starten/stoppen.
  window.addEventListener(BG_CONFIG_EVENT, () => {
    cfg = getBgConfig();
    scene.setConfig(cfg);
    app.ticker.maxFPS = cfg.fps;
    applyEnabled(bgEnabled(cfg));
  });

  // ── Wiedergabe-Reaktivität ───────────────────────────────────────────
  // RuntimeFeed (app/runtime.ts) feuert diese Fensterevents bei jedem
  // Snapshot bzw. jeder Notensendung. Ohne laufende Wiedergabe kommt nichts.
  window.addEventListener("mr-runtime", (e) => {
    const d = (e as CustomEvent).detail ?? {};
    // pulsesPerSec 48 ≈ 120 BPM (24 PPQN) → Faktor 1.0.
    const factor = cfg.reactBpm && d.playing ? (d.pulsesPerSec ?? 48) / 48 : 1;
    scene.setTempo(factor);
  });
  window.addEventListener("mr-note", (e) => {
    if (!cfg.reactNotes) return;
    scene.pulse((e as CustomEvent).detail?.strength ?? 1);
  });
}
