//! Ein „Keys link" auf dem Dashboard: leitet die Spiel-Nachrichten eines
//! angeschlossenen MIDI-Controllers live an ein Ziel-Device weiter — der
//! schnelle Weg, die MiniLab erst auf den D mini und danach auf den J-6 zu
//! spielen, ohne umzustecken. Mehrere Links dürfen gleichzeitig „LIVE" sein.
//!
//!  - Untere Hälfte (die große „LIVE"-Fläche) → an/aus, ohne Umweg (on the fly).
//!  - Obere Hälfte antippen → Menü (Ziel/Kanal/Transpose/Entfernen).
//!  - Obere Hälfte ziehen → frei positionieren (kein „Move"-Modus nötig).

import { useRef, useState } from "react";
import { useSend } from "../store";
import type { KeyLink } from "../../state";

const W = 224;
const H = 160;
/** Höhe der großen „LIVE"-Schaltfläche — rund die Hälfte der Kachel, damit
 *  man sie im Eifer des Gefechts sicher trifft. */
const LIVE_H = 78;
const DRAG_SLOP = 4;

/** „Arturia MiniLab mkII MIDI 1" → „Arturia MiniLab mkII" — der OS-Portname
 *  trägt oft einen generischen „ MIDI n"-Suffix, der auf der Kachel nur Platz
 *  frisst. */
function shortPort(port: string): string {
  return port.replace(/\s+MIDI(\s+\d+)?$/i, "").trim() || port;
}

export interface KeyLinkWidgetProps {
  link: KeyLink;
  deviceName: string | undefined;
  /** Hat das Ziel-Device einen MIDI-Ausgang? Fehlt einer, geht nichts raus —
   *  die Kachel sagt das dann laut, statt still zu schlucken. */
  deviceHasPort: boolean;
  zoom: number;
  /** Blitzt kurz auf, während Noten durchlaufen (`keyLink.activity`). */
  active?: boolean;
  /** Tipp auf die obere Hälfte → Menü (Parent rendert es). */
  onOpenMenu: () => void;
}

export function KeyLinkWidget({ link, deviceName, deviceHasPort, zoom, active, onOpenMenu }: KeyLinkWidgetProps) {
  const send = useSend();
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<"pending" | "drag" | "done">("done");
  const start = useRef({ gx: 0, gy: 0, x: 0, y: 0 });

  const x = dragPos?.x ?? link.x ?? 24;
  const y = dragPos?.y ?? link.y ?? 24;

  // Drag / Tipp-für-Menü läuft NUR über die obere Hälfte — die „LIVE"-Fläche
  // unten stoppt den Pointer und schaltet nur um.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); // nicht an den Dashboard-Hintergrund (Learn/Pan) durchreichen
    if (e.button === 2) return; // Rechtsklick → onContextMenu unten
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { gx: e.clientX, gy: e.clientY, x, y };
    gesture.current = "pending";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current === "done") return;
    const dx = (e.clientX - start.current.gx) / zoom;
    const dy = (e.clientY - start.current.gy) / zoom;
    if (gesture.current === "pending" && Math.hypot(dx, dy) <= DRAG_SLOP) return;
    gesture.current = "drag";
    setDragPos({ x: start.current.x + dx, y: Math.max(30, start.current.y + dy) });
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (gesture.current === "drag") {
      send({ t: "keyLink.move", linkId: link.id, x: Math.round(x), y: Math.round(y) });
      setDragPos(null);
    } else if (gesture.current === "pending") {
      onOpenMenu();
    }
    gesture.current = "done";
  };

  const on = link.enabled;
  const warn = !deviceName ? "no target — tap to set" : !deviceHasPort ? "target has no MIDI out" : null;
  const accent = warn ? "255, 120, 90" : "var(--pal-run-rgb)";

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: W,
        height: H,
        borderRadius: 14,
        overflow: "hidden",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
        background: warn ? "rgba(255, 120, 90, 0.12)" : "rgba(255, 255, 255, 0.05)",
        border: `1.5px solid ${
          warn ? "rgba(255, 120, 90, 0.8)" : on ? "rgba(var(--pal-run-rgb), 0.85)" : "rgba(255, 255, 255, 0.22)"
        }`,
        boxShadow: active ? `0 0 0 4px rgba(${accent}, 0.6)` : "none",
        transition: "box-shadow 90ms, border-color 120ms",
      }}
    >
      {/* Obere Hälfte: Info + Ziehen + Tipp-für-Menü. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          cursor: "grab",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenMenu();
        }}
      >
        <div
          style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={link.port}
        >
          ♪ {shortPort(link.port)}
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: deviceName ? "var(--pal-white)" : "var(--pal-text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ↓ {deviceName ?? "pick a synth"}
          {link.channel != null && <span style={{ color: "var(--pal-text-dim)" }}> · ch{link.channel}</span>}
          {link.transpose ? (
            <span style={{ color: "var(--pal-text-dim)" }}>
              {" "}
              · {link.transpose > 0 ? "+" : ""}
              {link.transpose}
            </span>
          ) : null}
        </div>
        {warn && (
          <div style={{ marginTop: "auto", fontSize: 11, fontWeight: 700, color: "rgb(255, 140, 110)" }}>{warn}</div>
        )}
      </div>

      {/* Untere Hälfte: die große „LIVE"-Schaltfläche. */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          send({ t: "keyLink.setEnabled", linkId: link.id, enabled: !on });
        }}
        style={{
          height: LIVE_H,
          flex: "none",
          border: "none",
          borderTop: "1.5px solid rgba(255, 255, 255, 0.16)",
          cursor: "pointer",
          fontSize: 20,
          fontWeight: 800,
          letterSpacing: 1,
          color: on ? "#0c0c0c" : "var(--pal-text-dim)",
          background: on ? "rgb(var(--pal-run-rgb))" : "rgba(255, 255, 255, 0.09)",
          transition: "background 120ms, color 120ms",
        }}
      >
        {on ? "● LIVE" : "○ OFF"}
      </button>
    </div>
  );
}
