//! Piano-Rolle OHNE Zellraster: Noten sind Balken auf einer Zeitachse, nicht
//! angekreuzte Kästchen.
//!
//! Warum kein Raster mehr: ein Raster zwingt jede Note auf einen Step — wer
//! Takes einspielt, will aber die Spielweise behalten (zu früh, zu spät, kurz
//! angestoßen), und wer von Hand setzt, trifft auf dem Touchdisplay mit 64px-
//! Zellen kaum noch etwas, weil nach ein paar Takten nichts mehr auf den
//! Bildschirm passt. Hier gilt stattdessen:
//!
//!   • Eine Note beginnt dort, wo man hintippt — Step + `microTiming`, nicht
//!     der nächste Step. Ihre Länge ist frei (Bruchteile von Steps).
//!   • Zoom statt fester Zellgröße. Beim Öffnen passt der GANZE Baustein in die
//!     Breite; mit ↔/↕ (oder zwei Fingern) holt man sich ran, was man genau
//!     setzen will. Zoom hält den Punkt unter den Fingern fest.
//!   • Von den Zeitlinien bleiben nur schwache Takt-/Schlaglinien zur
//!     Orientierung. Sie fangen nichts ein.
//!
//! Gesten (alles am Balken selbst, weil Finger und Ziel dort dasselbe sind):
//!
//!   Tipper auf leere Fläche  = Note setzen (an genau dieser Stelle)
//!   Tipper auf Note          = Note entfernen
//!   Ziehen am rechten Ende   = Länge ändern, live unter dem Finger
//!   Ziehen am Rest der Note  = verschieben (Zeit frei, Tonhöhe pro Zeile)
//!   Langes Drücken           = Editor der Note bzw. Akkord-Auswahl (leer)
//!   Wischen auf leerer Fläche = scrollen (nativ, in beide Richtungen)
//!
//! Die Komponente kennt nur Ansicht und Gesten. Was ein Tipper BEDEUTET (Paint-
//! Werkzeug, Kommandos an den Server) entscheidet der Aufrufer — s. `MelodyGrid`.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { MelodyNote } from "../../state";
import type { useSend } from "../store";
import { noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { RollKey, ROLL_LOW_NOTE, ROLL_HIGH_NOTE, HOLD_MS, isBlackKey } from "./StepGrid";

/** Breite der Klaviatur links. Schmaler als früher (78): die Zeit ist das, was
 *  hier Platz braucht. Breit genug für einen Finger bleibt sie trotzdem. */
const KEY_W = 56;
/** Höhe des Lineals oben. */
const RULER_H = 28;

/** Zeilenhöhe: Startwert, Grenzen. Klein anfangen ("immer zu groß"), mit ↕ ran. */
const ROW_DEFAULT = 28;
const ROW_MIN = 12;
const ROW_MAX = 80;

/** Größte Breite eines Steps in Pixeln — darüber wird es nur noch gröber. */
const PX_MAX = 480;
/** Faktor eines Zoom-Tippers. */
const ZOOM_STEP = 1.6;

/** Kürzeste Notenlänge, die die Geste erzeugt (Steps). Der Server klemmt bei
 *  dem gleichen Wert. */
export const ROLL_MIN_LENGTH = 0.05;

/** Bewegung in Pixeln, ab der eine Berührung eine Geste ist und kein Zittern. */
const SLOP = 10;

const ROW_COUNT = ROLL_HIGH_NOTE - ROLL_LOW_NOTE + 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Gemeinsamer Schalter für „zwei Finger sind unten" — Gesten auf Noten und
 *  Fläche brechen dann ab, statt beim Zoomen eine Note zu verschieben. */
interface GestureLock {
  pinch: boolean;
}

export interface RollCanvasProps {
  blockId: string;
  notes: readonly MelodyNote[];
  totalSteps: number;
  stepsPerBar: number;
  /** Tonhöhe, bei der die Rolle (ohne Noten) zu stehen kommt. */
  centerNote: number;
  send: ReturnType<typeof useSend>;
  /** Schreib-Cursor des Einspielens im Step-Modus: als Band im Raum markiert,
   *  im Lineal antippbar (`onPickStep`). */
  cursorStep?: number;
  onPickStep?: (step: number) => void;
  /** Zeit `t` in Steps (Bruchteile erlaubt), `pitch` als MIDI-Note. */
  onTapEmpty: (t: number, pitch: number) => void;
  onLongPressEmpty: (t: number, pitch: number) => void;
  onTapNote: (n: MelodyNote) => void;
  onLongPressNote: (n: MelodyNote) => void;
  onMoveNote: (n: MelodyNote, t: number, pitch: number) => void;
  onResizeNote: (n: MelodyNote, lengthSteps: number) => void;
}

interface Anchor {
  /** Inhaltspunkt (Steps bzw. Zeilen), der unter (vx, vy) bleiben soll. */
  tx: number;
  ty: number;
  vx: number;
  vy: number;
}

export function RollCanvas(props: RollCanvasProps) {
  const {
    blockId,
    notes,
    totalSteps,
    stepsPerBar,
    centerNote,
    send,
    cursorStep,
    onPickStep,
    onTapEmpty,
    onLongPressEmpty,
    onTapNote,
    onLongPressNote,
    onMoveNote,
    onResizeNote,
  } = props;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [vw, setVw] = useState(0);
  // 1 = der ganze Baustein passt in die Breite.
  const [hZoom, setHZoom] = useState(1);
  const [rowH, setRowH] = useState(ROW_DEFAULT);
  const lock = useRef<GestureLock>({ pinch: false });

  const total = Math.max(1, totalSteps);
  const fitPx = vw > 0 ? Math.max(1.5, (vw - KEY_W - 8) / total) : 16;
  const maxZoom = Math.max(1, PX_MAX / fitPx);
  const px = fitPx * clamp(hZoom, 1, maxZoom);
  const rollW = px * total;

  // Aktueller Stand für Handler, die nicht bei jedem Render neu hängen sollen.
  const geo = useRef({ px, rowH, fitPx, maxZoom });
  geo.current = { px, rowH, fitPx, maxZoom };

  // Breite des Ausschnitts → Einpass-Zoom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const anchorRef = useRef<Anchor | null>(null);

  const anchorAt = useCallback((vx: number, vy: number): Anchor => {
    const el = scroller.current;
    const g = geo.current;
    return {
      tx: ((el?.scrollLeft ?? 0) + vx - KEY_W) / g.px,
      ty: ((el?.scrollTop ?? 0) + vy - RULER_H) / g.rowH,
      vx,
      vy,
    };
  }, []);

  const applyZoom = useCallback((nextH: number, nextRow: number, anchor: Anchor) => {
    anchorRef.current = anchor;
    setHZoom(clamp(nextH, 1, geo.current.maxZoom));
    setRowH(clamp(nextRow, ROW_MIN, ROW_MAX));
  }, []);

  /** Bildmitte als Fixpunkt, wenn kein Finger den Zoom lenkt (Tasten). */
  const centerAnchor = useCallback(() => {
    const el = scroller.current;
    return anchorAt(el ? (el.clientWidth + KEY_W) / 2 : 0, el ? (el.clientHeight + RULER_H) / 2 : 0);
  }, [anchorAt]);

  // Nach dem Zoom den Fixpunkt zurück unter den Finger scrollen — vor dem
  // Malen, sonst springt der Ausschnitt für einen Frame.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = scroller.current;
    if (!a || !el) return;
    anchorRef.current = null;
    el.scrollLeft = a.tx * px + KEY_W - a.vx;
    el.scrollTop = a.ty * rowH + RULER_H - a.vy;
  }, [px, rowH]);

  // Zwei Finger = zoomen (waagerecht und senkrecht getrennt, je nach Achse, in
  // der die Finger auseinander liegen). Das Scrollen des Browsers wird dafür
  // vorübergehend abgestellt — es greift sonst parallel in den Ausschnitt.
  // Am Rechner: Strg + Mausrad bzw. Trackpad-Pinch.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let pinch: { dx: number; dy: number; h: number; row: number; anchor: Anchor } | null = null;

    const spread = (t: TouchList) => ({
      dx: Math.abs(t[0].clientX - t[1].clientX),
      dy: Math.abs(t[0].clientY - t[1].clientY),
      cx: (t[0].clientX + t[1].clientX) / 2,
      cy: (t[0].clientY + t[1].clientY) / 2,
    });
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const s = spread(e.touches);
      const rect = el.getBoundingClientRect();
      pinch = {
        dx: s.dx,
        dy: s.dy,
        h: geo.current.px / geo.current.fitPx,
        row: geo.current.rowH,
        anchor: anchorAt(s.cx - rect.left, s.cy - rect.top),
      };
      lock.current.pinch = true;
      el.style.overflow = "hidden";
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const s = spread(e.touches);
      // Nur die Achse zoomen, auf der die Finger auch wirklich auseinander
      // stehen — sonst kippt ein fast senkrechter Pinch den Zeitzoom um.
      const fh = pinch.dx >= 30 ? s.dx / pinch.dx : 1;
      const fv = pinch.dy >= 30 ? s.dy / pinch.dy : 1;
      applyZoom(pinch.h * fh, pinch.row * fv, pinch.anchor);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2 || !pinch) return;
      pinch = null;
      lock.current.pinch = false;
      el.style.overflow = "auto";
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * 0.01);
      const g = geo.current;
      applyZoom((g.px / g.fitPx) * f, g.rowH, anchorAt(e.clientX - rect.left, e.clientY - rect.top));
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
      el.style.overflow = "auto";
      lock.current.pinch = false;
    };
  }, [anchorAt, applyZoom]);

  // ── Start-Ausschnitt & Sprünge ────────────────────────────────────────────
  const rowTop = (note: number) => RULER_H + (ROLL_HIGH_NOTE - note) * geo.current.rowH;

  const scrollToNote = useCallback((note: number, smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    const wanted = rowTop(note) + geo.current.rowH / 2 - el.clientHeight / 2;
    el.scrollTo({ top: Math.max(0, wanted), behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Beim Öffnen dorthin, wo die Musik ist: Mitte der vorhandenen Noten, sonst
  // die Grundnote. Einmal — danach gehört der Ausschnitt dem Finger.
  const centered = useRef(false);
  useLayoutEffect(() => {
    if (centered.current || vw === 0) return;
    centered.current = true;
    if (notes.length === 0) {
      scrollToNote(centerNote, false);
      return;
    }
    const pitches = notes.map((n) => n.note).sort((a, b) => a - b);
    scrollToNote(pitches[Math.floor(pitches.length / 2)], false);
  }, [vw, notes, centerNote, scrollToNote]);

  const jumpOctave = (semitones: number) => {
    scroller.current?.scrollBy({ top: -semitones * geo.current.rowH, behavior: "smooth" });
  };

  // ── Leere Fläche: Tipper / langes Drücken ─────────────────────────────────
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const empty = useRef<{ id: number; x: number; y: number; timer?: number; dead: boolean; fired: boolean } | null>(null);

  /** Pixel auf der Fläche → Zeit in Steps und Tonhöhe. */
  const locate = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const g = geo.current;
    return {
      t: clamp((clientX - rect.left) / g.px, 0, total),
      pitch: clamp(ROLL_HIGH_NOTE - Math.floor((clientY - rect.top) / g.rowH), ROLL_LOW_NOTE, ROLL_HIGH_NOTE),
    };
  };

  const killEmpty = () => {
    if (empty.current) window.clearTimeout(empty.current.timer);
    empty.current = null;
  };

  // ── Zeitlinien (nur Orientierung) ─────────────────────────────────────────
  const beatSteps = Math.max(1, stepsPerBar / 4);
  const beatPx = beatSteps * px;
  const barPx = stepsPerBar * px;
  const guides: CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage: [
      "linear-gradient(to right, rgba(255,255,255,0.16) 1px, transparent 1px)",
      beatPx >= 14 ? "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px)" : "",
    ]
      .filter(Boolean)
      .join(","),
    backgroundSize: [`${barPx}px 100%`, beatPx >= 14 ? `${beatPx}px 100%` : ""].filter(Boolean).join(","),
  };

  // Lineal: Taktnummern, so dicht wie sie lesbar bleiben; Schläge, wenn Platz.
  const barEvery = Math.max(1, Math.ceil(30 / Math.max(1, barPx)));
  const bars = Math.ceil(total / Math.max(1, stepsPerBar));
  const rulerMarks: { x: number; label: string; major: boolean }[] = [];
  for (let b = 0; b < bars; b += barEvery) {
    rulerMarks.push({ x: b * barPx, label: String(b + 1), major: true });
  }
  if (beatPx >= 44) {
    for (let b = 0; b < bars; b++) {
      for (let k = 1; k < 4; k++) {
        const x = b * barPx + k * beatPx;
        if (x < rollW) rulerMarks.push({ x, label: `${b + 1}.${k + 1}`, major: false });
      }
    }
  }

  const rows: number[] = [];
  for (let note = ROLL_HIGH_NOTE; note >= ROLL_LOW_NOTE; note--) rows.push(note);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Zoom links (der Grund dieser Rolle), Oktavsprünge rechts. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 6, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
        <Button
          variant="alt"
          style={ZOOM_BTN}
          title="Zoom out in time"
          disabled={hZoom <= 1}
          onClick={() => applyZoom(hZoom / ZOOM_STEP, rowH, centerAnchor())}
        >
          ↔ −
        </Button>
        <Button
          variant="alt"
          style={ZOOM_BTN}
          title="Zoom in on time — place notes more precisely"
          disabled={px >= PX_MAX}
          onClick={() => applyZoom(hZoom * ZOOM_STEP, rowH, centerAnchor())}
        >
          ↔ +
        </Button>
        <Button
          variant="alt"
          style={ZOOM_BTN}
          title="Smaller rows — see more pitches"
          disabled={rowH <= ROW_MIN}
          onClick={() => applyZoom(hZoom, rowH / ZOOM_STEP, centerAnchor())}
        >
          ↕ −
        </Button>
        <Button
          variant="alt"
          style={ZOOM_BTN}
          title="Bigger rows — easier to hit with a finger"
          disabled={rowH >= ROW_MAX}
          onClick={() => applyZoom(hZoom, rowH * ZOOM_STEP, centerAnchor())}
        >
          ↕ +
        </Button>
        <Button
          variant="alt"
          style={{ ...ZOOM_BTN, width: 52 }}
          title="Show the whole block"
          onClick={() => applyZoom(1, ROW_DEFAULT, centerAnchor())}
        >
          Fit
        </Button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Button variant="alt" style={{ ...ZOOM_BTN, width: 52 }} title="Scroll one octave up" onClick={() => jumpOctave(12)}>
            +8ve
          </Button>
          <Button variant="alt" style={{ ...ZOOM_BTN, width: 52 }} title="Scroll one octave down" onClick={() => jumpOctave(-12)}>
            −8ve
          </Button>
        </div>
      </div>

      <div
        ref={scroller}
        className="roll-viewport"
        style={{
          flex: 1,
          minHeight: 220,
          overflow: "auto",
          position: "relative",
          // Beide Richtungen nativ (Wischen auf leerer Fläche scrollt); den
          // Browser-eigenen Pinch-Zoom der SEITE gibt es hier nicht — das
          // übernimmt der Zeit-/Zeilenzoom oben.
          touchAction: "pan-x pan-y",
          overscrollBehavior: "contain",
        }}
      >
        <div style={{ position: "relative", width: KEY_W + rollW, height: RULER_H + ROW_COUNT * rowH }}>
          {/* Lineal — klebt oben; im Step-Modus des Einspielens antippbar. */}
          <div
            className="roll-ruler"
            style={{ position: "sticky", top: 0, zIndex: 4, height: RULER_H, width: KEY_W + rollW }}
          >
            <div className="roll-ruler-corner" style={{ width: KEY_W, height: RULER_H }} />
            <div
              style={{
                position: "absolute",
                left: KEY_W,
                top: 0,
                width: rollW,
                height: RULER_H,
                cursor: onPickStep ? "pointer" : undefined,
              }}
              onPointerUp={
                onPickStep
                  ? (e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      onPickStep(Math.floor(clamp((e.clientX - rect.left) / px, 0, total - 1)));
                    }
                  : undefined
              }
            >
              {cursorStep !== undefined && (
                <div className="roll-cursor-mark" style={{ left: cursorStep * px, width: Math.max(3, px), height: RULER_H }} />
              )}
              {rulerMarks.map((m) => (
                <div key={`${m.label}`} className={`roll-tick${m.major ? " major" : ""}`} style={{ left: m.x }}>
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {/* Tonhöhen-Zeilen mit Klaviatur links. In normalem Fluss — die Fläche
              mit den Noten liegt als Ebene darüber. */}
          {rows.map((note) => {
            const isC = note % 12 === 0;
            return (
              <div
                key={note}
                style={{
                  display: "flex",
                  height: rowH,
                  width: KEY_W + rollW,
                  background: isC ? "var(--pal-panel-deep)" : isBlackKey(note) ? "var(--pal-roll-black)" : "var(--pal-roll-white)",
                  boxShadow: isC ? "inset 0 -1px 0 var(--pal-step-border)" : undefined,
                }}
              >
                <RollKey
                  note={note}
                  label={noteName(note)}
                  height={rowH}
                  width={KEY_W}
                  side="left"
                  onPress={() => send({ t: "block.previewNote", blockId, note, on: true })}
                  onRelease={() => send({ t: "block.previewNote", blockId, note, on: false })}
                />
              </div>
            );
          })}

          {/* Fläche mit den Noten. */}
          <div
            ref={surfaceRef}
            className="roll-surface"
            style={{ position: "absolute", left: KEY_W, top: RULER_H, width: rollW, height: ROW_COUNT * rowH, touchAction: "pan-x pan-y" }}
            onPointerDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (!e.isPrimary || lock.current.pinch) {
                if (empty.current) empty.current.dead = true;
                return;
              }
              killEmpty();
              const rec = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: undefined as number | undefined, dead: false, fired: false };
              rec.timer = window.setTimeout(() => {
                if (rec.dead) return;
                rec.fired = true;
                const at = locate(rec.x, rec.y);
                onLongPressEmpty(at.t, at.pitch);
              }, HOLD_MS);
              empty.current = rec;
            }}
            onPointerMove={(e) => {
              const r = empty.current;
              if (!r || r.id !== e.pointerId || r.dead) return;
              if (lock.current.pinch || Math.max(Math.abs(e.clientX - r.x), Math.abs(e.clientY - r.y)) > SLOP) {
                // Der Browser übernimmt als Scrollen (gleich folgt pointercancel).
                r.dead = true;
                window.clearTimeout(r.timer);
              }
            }}
            onPointerUp={(e) => {
              const r = empty.current;
              if (!r || r.id !== e.pointerId) return;
              killEmpty();
              if (r.dead || r.fired || lock.current.pinch) return;
              const at = locate(r.x, r.y);
              onTapEmpty(at.t, at.pitch);
            }}
            onPointerCancel={killEmpty}
          >
            <div style={guides} />
            {cursorStep !== undefined && (
              <div className="roll-cursor-band" style={{ left: cursorStep * px, width: Math.max(3, px) }} />
            )}
            {notes.map((n) => (
              <NoteBar
                key={`${n.step}:${n.note}`}
                n={n}
                px={px}
                rowH={rowH}
                totalSteps={total}
                lock={lock}
                onTap={onTapNote}
                onLong={onLongPressNote}
                onMove={onMoveNote}
                onResize={onResizeNote}
              />
            ))}
            {/* Playhead als dünne Linie; `--play` (0..1) wird von der Runtime
                weich interpoliert, `.block-detail.playing` blendet ihn ein. */}
            <div className="roll-playhead" style={{ "--roll-w": `${rollW}px` } as CSSProperties} />
          </div>
        </div>
      </div>
    </div>
  );
}

const ZOOM_BTN = { width: 60, height: 34, fontSize: 14 } as const;

// ── Eine Note ───────────────────────────────────────────────────────────────

function NoteBar({
  n,
  px,
  rowH,
  totalSteps,
  lock,
  onTap,
  onLong,
  onMove,
  onResize,
}: {
  n: MelodyNote;
  px: number;
  rowH: number;
  totalSteps: number;
  lock: { current: GestureLock };
  onTap: (n: MelodyNote) => void;
  onLong: (n: MelodyNote) => void;
  onMove: (n: MelodyNote, t: number, pitch: number) => void;
  onResize: (n: MelodyNote, lengthSteps: number) => void;
}) {
  const start = n.step + (n.microTiming ?? 0);
  const len = Math.max(ROLL_MIN_LENGTH, n.lengthSteps ?? 1);
  // Lokale Vorschau während des Ziehens — der Server-Snapshot kommt erst nach
  // dem Loslassen und würde die Note unter dem Finger ruckeln lassen.
  const [preview, setPreviewState] = useState<{ dx: number; dy: number; len: number } | null>(null);
  // Zusätzlich als Ref: Loslassen kann im selben Frame wie die letzte Bewegung
  // kommen, bevor React neu gerendert hat — dann wäre `preview` einen Schritt alt.
  const previewRef = useRef<{ dx: number; dy: number; len: number } | null>(null);
  const setPreview = (v: { dx: number; dy: number; len: number } | null) => {
    previewRef.current = v;
    setPreviewState(v);
  };
  const g = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    zone: "move" | "resize";
    mode: "idle" | "drag" | "dead";
    timer?: number;
    fired: boolean;
  } | null>(null);

  const stop = () => {
    if (g.current) window.clearTimeout(g.current.timer);
    g.current = null;
    setPreview(null);
  };
  useEffect(() => () => window.clearTimeout(g.current?.timer), []);

  const maxLen = Math.max(ROLL_MIN_LENGTH, totalSteps - start);
  const width = Math.max(10, len * px - 1);
  const left = start * px;
  const top = (ROLL_HIGH_NOTE - n.note) * rowH;
  const shown = preview ? { dx: preview.dx, dy: preview.dy, w: Math.max(10, preview.len * px - 1) } : { dx: 0, dy: 0, w: width };
  const dragging = preview !== null;
  const vel = Math.min(127, Math.max(1, n.velocity ?? 100));

  return (
    <div
      className="roll-note"
      style={{
        position: "absolute",
        left,
        top: top + 1,
        width: shown.w,
        height: rowH - 2,
        transform: `translate(${shown.dx}px, ${shown.dy}px)`,
        // Anschlagstärke als Deckkraft: laute Noten stehen vor, leise treten
        // zurück — die Dynamik einer Melodie liest man so im Vorbeigehen.
        opacity: dragging ? 0.85 : 0.55 + 0.45 * (vel / 127),
        zIndex: dragging ? 3 : 1,
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!e.isPrimary || lock.current.pinch) return;
        stop();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const rect = e.currentTarget.getBoundingClientRect();
        // Greifbereich am rechten Ende: breit für den Finger, aber bei sehr
        // schmalen Noten nie mehr als ihre halbe Breite — sonst ließe sich
        // so eine Note nicht mehr verschieben.
        const handle = Math.min(28, Math.max(10, rect.width * 0.4));
        const rec = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          left: rect.left,
          zone: e.clientX > rect.right - handle ? ("resize" as const) : ("move" as const),
          mode: "idle" as "idle" | "drag" | "dead",
          timer: undefined as number | undefined,
          fired: false,
        };
        rec.timer = window.setTimeout(() => {
          if (rec.mode !== "idle") return;
          rec.fired = true;
          onLong(n);
        }, HOLD_MS);
        g.current = rec;
      }}
      onPointerMove={(e) => {
        const r = g.current;
        if (!r || r.id !== e.pointerId || r.mode === "dead") return;
        if (lock.current.pinch) {
          window.clearTimeout(r.timer);
          r.mode = "dead";
          setPreview(null);
          return;
        }
        const dx = e.clientX - r.x;
        const dy = e.clientY - r.y;
        if (r.mode === "idle") {
          if (r.fired || Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
          r.mode = "drag";
          window.clearTimeout(r.timer);
        }
        if (r.zone === "resize") {
          setPreview({ dx: 0, dy: 0, len: clamp((e.clientX - r.left) / px, ROLL_MIN_LENGTH, maxLen) });
        } else {
          setPreview({ dx, dy: Math.round(dy / rowH) * rowH, len });
        }
      }}
      onPointerUp={(e) => {
        const r = g.current;
        if (!r || r.id !== e.pointerId) return;
        const final = previewRef.current;
        const { mode, zone, fired } = r;
        stop();
        if (mode === "drag" && final) {
          if (zone === "resize") onResize(n, final.len);
          else onMove(n, start + final.dx / px, n.note - Math.round(final.dy / rowH));
        } else if (mode === "idle" && !fired) {
          onTap(n);
        }
      }}
      onPointerCancel={stop}
    >
      <div className="roll-note-body">
        {width >= 34 && rowH >= 18 ? noteName(n.note) : null}
      </div>
      <div className="roll-note-handle" />
    </div>
  );
}
