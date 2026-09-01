//! Bildrate neben der Positionsanzeige in der Transport-Leiste. Optional —
//! einzuschalten unter ⚙ → Background scene; ausgeschaltet wird die Komponente
//! gar nicht erst gemountet, es läuft also auch keine Messschleife.
//!
//! Gemessen wird per eigenem requestAnimationFrame, nicht am Pixi-Ticker: der
//! ist auf 30 fps gedeckelt (s. background.ts) und steht bei Preset „off" ganz
//! still. Interessant ist aber, wie flüssig die OBERFLÄCHE läuft, während die
//! Szene den Pi beschäftigt — genau das zeigt eine eigene rAF-Schleife.

import { useEffect, useState } from "react";

/** Mittelungsfenster: oft genug zum Beobachten beim Drehen an den Reglern,
 *  selten genug, dass das State-Update nicht selbst ins Gewicht fällt. */
const WINDOW_MS = 500;

export function FpsMeter() {
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let since = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      frames++;
      const span = now - since;
      if (span >= WINDOW_MS) {
        setFps(Math.round((frames * 1000) / span));
        frames = 0;
        since = now;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Ampel: der Pi zielt auf 60 Hz Oberfläche; unter 50 wird es sichtbar zäh,
  // unter 25 ruckelt auch der Baustein-Sweep.
  const color =
    fps === null || fps >= 50
      ? "var(--pal-text-dim)"
      : fps >= 25
        ? "var(--pal-white)"
        : "var(--pal-stop)";

  return (
    <span
      className="mono"
      title="Frames per second (⚙ → Background scene to hide)"
      style={{
        fontSize: 12,
        fontWeight: 700,
        color,
        // Feste Breite, damit die danebenstehende Position beim Zappeln der
        // Zahl nicht hin und her springt.
        minWidth: 46,
        textAlign: "right",
        opacity: 0.85,
      }}
    >
      {fps === null ? "—" : fps} fps
    </span>
  );
}
