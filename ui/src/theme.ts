//! Zentrale Schwarzweiß-Palette. Schwarzes Wasser, weiße Elemente, monochrome
//! Bedienflächen. Alle UI-Komponenten beziehen ihre Farben von hier.

export const PAL = {
  black: 0x000000,
  // Wasser-Verlauf (oben etwas heller, unten reines Schwarz).
  waterTop: 0x1a1a1a,
  waterMid: 0x0d0d0d,
  waterDeep: 0x000000,

  white: 0xffffff,
  text: 0xf2f2f2, // helle Beschriftung
  textDim: 0x8a8a8a, // gedämpfte Beschriftung
  ink: 0x050505, // dunkle Schrift auf Weiß

  line: 0xffffff, // Ränder (mit niedriger Alpha eingesetzt)
  panel: 0x111111, // Panels / Leisten
  panelDeep: 0x080808, // tiefere Flächen (Lanes)

  btn: 0x1c1c1c, // Standard-Button
  btnAlt: 0x2a2a2a, // sekundärer Button
  btnActive: 0xf0f0f0, // aktiver Toggle (Weiß)
  danger: 0x2b2b2b, // Panic/Löschen (monochrom, nur dezent abgesetzt)
};

/** Hex-Farbstring ("#rrggbb") → Zahl; Fallback Weiß. */
export function hexToNum(hex?: string): number {
  if (!hex) return PAL.white;
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(n) ? PAL.white : n;
}
