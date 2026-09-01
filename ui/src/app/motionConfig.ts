//! Animationen an/aus — pro Gerät (localStorage), wie [uiScale.ts]: ein
//! Raspi-Touchdisplay darf sie abschalten, während der Entwicklungs-Mac sie
//! zeigt.
//!
//! Warum es diesen Schalter gibt: die Dauer-Animationen der Oberfläche
//! (`hifi-sheen`, `hifi-glint`, `transport-stop-glow`) animieren
//! `background-position` bzw. `box-shadow` — Eigenschaften, die der Compositor
//! NICHT beschleunigen kann. Jede laufende solche Animation zwingt den Browser,
//! die Seite ~60×/s komplett neu zu rastern, und zwar unabhängig davon, wie
//! klein das animierte Element ist.
//!
//! Auf dem Pi 5 gemessen (Anteil EINES Kerns, Chromium gesamt):
//!
//!   Szene an  + Animationen an : 50 %      Szene aus + Animationen an : 71 %
//!   Szene an  + Animationen aus: 39 %      Szene aus + Animationen aus:  4 %
//!
//! Der Effekt ist eine Klippe, keine Rampe: EINE übrig gebliebene Animation
//! hält das Neurastern komplett am Laufen (einzeln abschalten brachte je nur
//! ~11 %, beide zusammen den Sprung auf 4 %). Deshalb schaltet dieser Schalter
//! pauschal ALLE ab und nicht einzelne.

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
