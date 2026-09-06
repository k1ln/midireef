//! Ein „Keys link" auf dem Dashboard: leitet die Spiel-Nachrichten eines
//! angeschlossenen MIDI-Controllers live an ein Ziel-Device weiter — der
//! schnelle Weg, die MiniLab erst auf den D mini und danach auf den J-6 zu
//! spielen, ohne umzustecken. Mehrere Links dürfen gleichzeitig „LIVE" sein.
//!
//!  - Tipp auf die Kachel → an/aus (LIVE ↔ aus).
//!  - Tipp auf den Zielnamen → anderes Device wählen (on the fly umhängen).
//!  - „Move"-Modus (wie bei den Controls) → ziehen zum Positionieren.
//!  - ✕ → Link entfernen.

import { useRef, useState } from "react";
import { useSend } from "../store";
import type { KeyLink } from "../../state";

const W = 158;
const H = 96;

/** „Arturia MiniLab mkII MIDI 1" → „Arturia MiniLab mkII" — der OS-Portname
 *  trägt oft einen generischen „ MIDI n"-Suffix, der auf der kleinen Kachel
 *  nur Platz frisst. */
function shortPort(port: string): string {
  return port.replace(/\s+MIDI(\s+\d+)?$/i, "").trim() || port;
}

export interface KeyLinkWidgetProps {
  link: KeyLink;
  deviceName: string | undefined;
  editMode: boolean;
  zoom: number;
  /** Blitzt kurz auf, während Noten durchlaufen (`keyLink.activity`). */
  active?: boolean;
  onPickDevice: () => void;
  onRemove: () => void;
}

export function KeyLinkWidget({ link, deviceName, editMode, zoom, active, onPickDevice, onRemove }: KeyLinkWidgetProps) {
  const send = useSend();
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const mode = useRef<"none" | "drag">("none");
  const start = useRef({ gx: 0, gy: 0, x: 0, y: 0 });
  const moved = useRef(false);

  const x = dragPos?.x ?? link.x ?? 24;
  const y = dragPos?.y ?? link.y ?? 24;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Nicht an den Dashboard-Hintergrund durchreichen — sonst startet dort
    // der MIDI-Learn-Langdruck / ein Pan.
    e.stopPropagation();
    if (e.button === 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { gx: e.clientX, gy: e.clientY, x, y };
    moved.current = false;
    mode.current = editMode ? "drag" : "none";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode.current !== "drag") return;
    const nx = start.current.x + (e.clientX - start.current.gx) / zoom;
    const ny = Math.max(30, start.current.y + (e.clientY - start.current.gy) / zoom);
    if (Math.abs(nx - start.current.x) > 2 || Math.abs(ny - start.current.y) > 2) moved.current = true;
    setDragPos({ x: nx, y: ny });
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (mode.current === "drag" && moved.current) {
      send({ t: "keyLink.move", linkId: link.id, x: Math.round(x), y: Math.round(y) });
      setDragPos(null);
    } else if (!editMode && !moved.current) {
      // Tipp = an/aus umschalten.
      send({ t: "keyLink.setEnabled", linkId: link.id, enabled: !link.enabled });
    }
    mode.current = "none";
  };

  const on = link.enabled;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: W,
        height: H,
        borderRadius: 12,
        padding: 10,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        cursor: editMode ? "grab" : "pointer",
        userSelect: "none",
        touchAction: "none",
        background: on ? "rgba(var(--pal-run-rgb), 0.16)" : "rgba(255, 255, 255, 0.05)",
        border: `1.5px solid ${on ? "rgba(var(--pal-run-rgb), 0.85)" : "rgba(255, 255, 255, 0.22)"}`,
        boxShadow: active ? "0 0 0 3px rgba(var(--pal-run-rgb), 0.55)" : "none",
        transition: "box-shadow 90ms, background 120ms, border-color 120ms",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={link.port}
        >
          ♪ {shortPort(link.port)}
        </span>
        <button
          type="button"
          aria-label="Remove keys link"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "20px",
            color: "var(--pal-white)",
            background: "rgba(255, 255, 255, 0.12)",
          }}
        >
          ✕
        </button>
      </div>

      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onPickDevice();
        }}
        style={{
          textAlign: "left",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          borderRadius: 7,
          background: "rgba(255, 255, 255, 0.06)",
          color: deviceName ? "var(--pal-white)" : "var(--pal-text-dim)",
          fontSize: 12,
          fontWeight: 700,
          padding: "5px 8px",
          cursor: "pointer",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        ↓ {deviceName ?? "no target — tap"}
      </button>

      <div
        style={{
          marginTop: "auto",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.5,
          color: on ? "rgb(var(--pal-run-rgb))" : "var(--pal-text-dim)",
        }}
      >
        {on ? "● LIVE" : "○ off"}
      </div>
    </div>
  );
}
