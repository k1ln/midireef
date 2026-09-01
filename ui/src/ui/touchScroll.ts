//! Scrollen per Touch — Zwei-Finger-Geste plus Ziehen an der Scrollleiste.
//!
//! ERGÄNZUNG, kein Ersatz: das native Ein-Finger-Scrollen funktioniert. Ein
//! früherer Verdacht, `touch-action: none` in index.html würde es abschalten,
//! war falsch — `touch-action` vererbt sich NICHT, die Scroll-Container stehen
//! auf `auto`. Die eigentliche Ursache dafür, dass auf dem Pi gar nichts
//! scrollte, lag außerhalb der App: labwc hatte für den Touchscreen
//! `mouseEmulation="yes"` gesetzt und lieferte Finger als Maus aus, sodass
//! Chromium überhaupt keine TouchEvents sah (s. deploy/README.md).
//!
//! Was hier trotzdem gebraucht wird:
//!
//!   • ZWEI Finger, irgendwo     → scrollt den nächstgelegenen Container.
//!     Eine ausdrückliche Geste, die unabhängig davon greift, was das berührte
//!     Element mit dem Zeiger macht — und die gewünscht war, damit EIN Finger
//!     fürs Auslösen von Bausteinen frei bleiben kann.
//!   • EIN Finger auf der Leiste → zieht den Scrollbalken. Chromium lässt
//!     Scrollleisten per Touch nicht ziehen; ohne das wäre die breite Leiste
//!     nur Anzeige und kein Griff.
//!
//! Beides mit Schwung-Nachlauf, weil abruptes Stoppen auf einem Touchscreen
//! unangenehm ist.

/** Reibung pro Frame für den Nachlauf (~60 fps). */
const FRICTION = 0.94;
/** Unter dieser Restgeschwindigkeit (px/Frame) endet der Nachlauf. */
const MIN_VELOCITY = 0.2;

type Axis = "y" | "x";

/** Nächster Vorfahr, der auf `axis` tatsächlich scrollbar ist. */
function scrollableAncestor(start: Element | null, axis: Axis): Element | null {
  const overflowProp = axis === "y" ? "overflowY" : "overflowX";
  const sizeProp = axis === "y" ? "scrollHeight" : "scrollWidth";
  const clientProp = axis === "y" ? "clientHeight" : "clientWidth";
  for (let el = start; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    const ov = style[overflowProp];
    if ((ov === "auto" || ov === "scroll") && el[sizeProp] - el[clientProp] > 1) return el;
  }
  return null;
}

function scrollBy(el: Element, axis: Axis, delta: number) {
  if (axis === "y") el.scrollTop += delta;
  else el.scrollLeft += delta;
}

export function wireTouchScroll() {
  // ── Zwei-Finger-Scrollen ────────────────────────────────────────────────
  let target: Element | null = null;
  let axis: Axis = "y";
  let lastPos = 0;
  let velocity = 0;
  let inertia = 0;

  const centroid = (t: TouchList, axis: Axis) =>
    axis === "y" ? (t[0].clientY + t[1].clientY) / 2 : (t[0].clientX + t[1].clientX) / 2;

  const stopInertia = () => {
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };

  const runInertia = () => {
    if (!target || Math.abs(velocity) < MIN_VELOCITY) {
      target = null;
      inertia = 0;
      return;
    }
    scrollBy(target, axis, velocity);
    velocity *= FRICTION;
    inertia = requestAnimationFrame(runInertia);
  };

  window.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      stopInertia();
      const el = document.elementFromPoint(
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        (e.touches[0].clientY + e.touches[1].clientY) / 2,
      );
      // Senkrecht ist der Normalfall; nur wenn nichts vertikal scrollbar ist,
      // auf die Waagerechte ausweichen (die Raster-Zeilen der Übersicht).
      const vertical = scrollableAncestor(el, "y");
      axis = vertical ? "y" : "x";
      target = vertical ?? scrollableAncestor(el, "x");
      if (!target) return;
      lastPos = centroid(e.touches, axis);
      velocity = 0;
    },
    { passive: false },
  );

  window.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (!target || e.touches.length !== 2) return;
      const pos = centroid(e.touches, axis);
      // Inhalt folgt dem Finger: nach unten wischen zeigt weiter oben.
      const delta = lastPos - pos;
      scrollBy(target, axis, delta);
      // Geglättet, damit ein einzelner Ausreißer den Nachlauf nicht verreißt.
      velocity = velocity * 0.7 + delta * 0.3;
      lastPos = pos;
      e.preventDefault();
    },
    { passive: false },
  );

  window.addEventListener("touchend", (e: TouchEvent) => {
    if (!target || e.touches.length >= 2) return;
    stopInertia();
    inertia = requestAnimationFrame(runInertia);
  });

  // ── Einen Finger an der Scrollleiste ziehen ─────────────────────────────
  // Mit `touch-action: none` greift auch das native Ziehen des Scrollbalkens
  // nicht, also hier selbst: der Griff wird proportional in scrollTop
  // umgerechnet (Balkenweg × Verhältnis Inhalt/Sichtfenster).
  let barTarget: Element | null = null;
  let barStartY = 0;
  let barStartScroll = 0;
  let barRatio = 1;

  window.addEventListener("pointerdown", (e: PointerEvent) => {
    const el = e.target as Element | null;
    if (!el) return;
    const style = getComputedStyle(el);
    const scrollable =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      el.scrollHeight - el.clientHeight > 1;
    if (!scrollable) return;
    // Auf der Leiste? `clientWidth` endet exakt an ihrer Innenkante, `clientLeft`
    // ist der linke Rahmen — daher ohne Zahl aus dem CSS auskommend, die sonst
    // bei jeder Breitenänderung nachgezogen werden müsste.
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left + el.clientLeft + el.clientWidth) return;

    barTarget = el;
    barStartY = e.clientY;
    barStartScroll = el.scrollTop;
    barRatio = el.scrollHeight / el.clientHeight;
    stopInertia();
    e.preventDefault();
  });

  window.addEventListener("pointermove", (e: PointerEvent) => {
    if (!barTarget) return;
    barTarget.scrollTop = barStartScroll + (e.clientY - barStartY) * barRatio;
    e.preventDefault();
  });

  const releaseBar = () => {
    barTarget = null;
  };
  window.addEventListener("pointerup", releaseBar);
  window.addEventListener("pointercancel", releaseBar);
}
