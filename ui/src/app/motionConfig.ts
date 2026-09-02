//! Animationen an/aus — pro Gerät (localStorage), wie [uiScale.ts]: ein
//! Raspi-Touchdisplay darf sie abschalten, während der Entwicklungs-Mac sie
//! zeigt.
//!
//! Geschichte: früher animierten die Dauer-Animationen (`transport-stop-glow`,
//! `queued-pulse`) `box-shadow` bzw. `outline-color` — Eigenschaften, die der
//! Compositor NICHT beschleunigt. Jede laufende solche Animation zwang den
//! Browser, die Seite ~60×/s komplett neu zu rastern, egal wie klein das
//! Element war. Auf dem Pi 5 gemessen (Anteil EINES Kerns, Chromium gesamt;
//! damals liefen zusätzlich `hifi-glint`/`hifi-sheen`, längst entfallen):
//!
//!   Szene an  + Animationen an : 50 %      Szene aus + Animationen an : 71 %
//!   Szene an  + Animationen aus: 39 %      Szene aus + Animationen aus:  4 %
//!
//! Der Effekt war eine Klippe, keine Rampe: EINE übrig gebliebene box-shadow-
//! Animation hielt das Neurastern komplett am Laufen. Inzwischen läuft in
//! `theme.css` KEINE Animation mehr über `box-shadow`/`outline-color`: der
//! Schein steht fest auf einem eigenen Layer (Pseudo-Element), animiert wird
//! nur dessen `opacity` — das macht der Compositor allein, ohne Neurastern.
//!
//! Der Schalter bleibt trotzdem: eine Dauer-Animation ist auch als reiner
//! Compositor-Job Bewegung im Blickfeld, die man an einem Live-Werkzeug soll
//! abstellen können. Er schaltet pauschal ALLE ab, damit nichts durchrutscht.

const KEY = "ui.motion";
/** Feuert nach jeder Änderung — Komponenten können sich neu zeichnen. */
export const MOTION_EVENT = "ui-motion-change";

export type Motion = "full" | "off";

export function getMotion(): Motion {
  try {
    return window.localStorage.getItem(KEY) === "off" ? "off" : "full";
  } catch {
    return "full";
  }
}

/** Setzt das Attribut, auf das `theme.css` hört (`:root[data-motion="off"]`). */
export function applyMotion(m: Motion): void {
  document.documentElement.dataset.motion = m;
  window.dispatchEvent(new Event(MOTION_EVENT));
}

export function setMotion(m: Motion): Motion {
  try {
    window.localStorage.setItem(KEY, m);
  } catch {
    /* Privatmodus — gilt dann nur für diese Sitzung. */
  }
  applyMotion(m);
  return m;
}
