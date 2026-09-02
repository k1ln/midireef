//! Einzel-Größen — getrennt vom groben Gesamt-Zoom (uiScale.ts): eine Regler-
//! Größe für alle antippbaren Knöpfe/Regler (`.btn`, `.pill-toggle`) UND
//! getrennte Schriftgrößen für Geräte- bzw. Lane-Namen. Jede Größe skaliert
//! per CSS-Variable, unabhängig von den anderen — man darf z.B. die Knöpfe
//! groß und die Lane-Schrift klein stellen. Gespeichert pro Gerät
//! (localStorage), wie uiScale/motionConfig.

export const UI_SIZE_EVENT = "ui-size-change";

export type SizeKey = "control" | "fontDevice" | "fontLane";

const STORAGE_KEY: Record<SizeKey, string> = {
  control: "ui.size.control",
  fontDevice: "ui.size.fontDevice",
  fontLane: "ui.size.fontLane",
};

/** CSS-Variable, an der die jeweilige Regel hängt — s. theme.css. */
const CSS_VAR: Record<SizeKey, string> = {
  control: "--ctrl-scale",
  fontDevice: "--fs-device-scale",
  fontLane: "--fs-lane-scale",
};

export const SIZE_MIN = 0.7;
export const SIZE_MAX = 1.6;
export const SIZE_STEP = 0.1;

function clampSize(v: number): number {
  const c = Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
  return Math.round(c * 100) / 100;
}

export function getSize(key: SizeKey): number {
  try {
    const v = parseFloat(window.localStorage.getItem(STORAGE_KEY[key]) ?? "");
    return Number.isFinite(v) ? clampSize(v) : 1;
  } catch {
    return 1;
  }
}

export function applySize(key: SizeKey, size: number): void {
  document.documentElement.style.setProperty(CSS_VAR[key], String(size));
  window.dispatchEvent(new Event(UI_SIZE_EVENT));
}

export function setSize(key: SizeKey, size: number): number {
  const c = clampSize(size);
  try {
    window.localStorage.setItem(STORAGE_KEY[key], String(c));
  } catch {
    /* Privatmodus — gilt dann nur für diese Sitzung. */
  }
  applySize(key, c);
  return c;
}

/** Beim Start alle drei Größen anwenden — s. App.tsx neben applyUiScale/applyMotion. */
export function applyAllSizes(): void {
  (Object.keys(STORAGE_KEY) as SizeKey[]).forEach((key) => applySize(key, getSize(key)));
}
