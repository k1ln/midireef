//! Geteilte Schwungrad-Physik für WheelPicker und Knob: Geschwindigkeit aus
//! den letzten ~100ms Zeiger-Bewegung (nicht Bild-für-Bild geglättet — das
//! unterschätzt systematisch einen kurzen, schnellen Flick, weil der
//! Glättungsfaktor bei nur 1-2 Events vor dem Loslassen kaum etwas von der
//! tatsächlichen Geschwindigkeit durchlässt), dann Abklingen per Reibung nach
//! dem Loslassen, damit ein harter Flick spürbar weiterläuft statt abrupt zu
//! stoppen, sobald der Finger abhebt.

export interface Sample {
  y: number;
  t: number;
}

/** Wie weit zurück (ms) die Geschwindigkeit beim Loslassen gemessen wird. */
export const VELOCITY_WINDOW_MS = 100;

export function startHistory(y: number, t: number): Sample[] {
  return [{ y, t }];
}

/** Fügt einen Punkt an und wirft alles vor dem Fenster raus (nicht bei jedem
 *  Wurf auf 1 Element kappen — die ältesten 2 bleiben immer, sonst hat ein
 *  einzelner Punkt kein `dt` mehr, aus dem sich eine Rate ergäbe). */
export function pushHistory(hist: Sample[], y: number, t: number): Sample[] {
  hist.push({ y, t });
  const cutoff = t - VELOCITY_WINDOW_MS;
  while (hist.length > 2 && hist[0].t < cutoff) hist.shift();
  return hist;
}

/** Geschwindigkeit in px/Frame (auf 60fps normiert) zwischen dem ältesten
 *  Punkt im Fenster und JETZT — positiv, wenn `y` seither gestiegen ist. */
export function velocityFromHistory(hist: Sample[], nowY: number, nowT: number): number {
  const oldest = hist[0];
  if (!oldest) return 0;
  const dt = Math.max(1, nowT - oldest.t);
  return ((nowY - oldest.y) / dt) * 16.6667;
}

/** Beschleunigungskurve für eine AKTIVE Ziehbewegung (nicht den Nachlauf): ein
 *  großer Sprung zwischen zwei Pointer-Events (= schneller Finger) bewegt den
 *  Wert überproportional weiter als viele kleine — schnelles Wischen deckt so
 *  große Bereiche schnell ab, während langsames Ziehen fein bleibt. `POWER`
 *  > 1 macht daraus eine Kurve statt einer Geraden. */
const ACCEL_POWER = 1.6;
const ACCEL_CAP = 6; // Deckel, gegen einen einzelnen Ausreißer-Event (Tab-Wechsel o.ä.)

export function acceleratedDelta(rawDeltaPx: number, unitsPerPx: number): number {
  const mag = Math.abs(rawDeltaPx);
  if (mag < 1) return rawDeltaPx * unitsPerPx;
  const accel = Math.min(ACCEL_CAP, Math.pow(mag, ACCEL_POWER - 1));
  return Math.sign(rawDeltaPx) * mag * unitsPerPx * accel;
}
