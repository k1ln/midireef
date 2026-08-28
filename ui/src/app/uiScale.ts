//! Globale UI-Skalierung — ein App-eigener Zoom, unabhängig vom Browser-Zoom
//! (der Kiosk-Modus versteckt ihn ohnehin). Gespeichert in localStorage, also
//! pro Gerät: ein kleiner Touchscreen darf größer stellen als ein Monitor.
//!
//! Umgesetzt über CSS `zoom` auf <html>: das skaliert das GESAMTE Layout inkl.
//! der vielen `position: fixed`-Overlays (Transport, Popups, Overview) — anders
//! als `transform: scale`, dem genau diese fixierten Ebenen entkämen.

const KEY = "ui.scale";
export const UI_SCALE_MIN = 0.6;
export const UI_SCALE_MAX = 1.8;
export const UI_SCALE_STEP = 0.1;

export function clampScale(v: number): number {
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v));
  return Math.round(clamped * 100) / 100;
}

export function getUiScale(): number {
  try {
    const v = parseFloat(window.localStorage.getItem(KEY) ?? "");
    return Number.isFinite(v) ? clampScale(v) : 1;
  } catch {
    return 1;
  }
}

export function applyUiScale(scale: number): void {
  // `zoom` ist kein Standard-CSSStyleDeclaration-Feld → als Zeichenkette setzen.
  (document.documentElement.style as unknown as Record<string, string>).zoom = String(scale);
}

export function setUiScale(scale: number): number {
  const c = clampScale(scale);
  try {
    window.localStorage.setItem(KEY, String(c));
  } catch {
    /* Privatmodus — gilt dann nur für diese Sitzung. */
  }
  applyUiScale(c);
  return c;
}
