//! Slot-Kachel — zwei Zonen (Ableton-„Session"-Prinzip):
//!
//!   • KÖRPER (oben, ~60 %): Antippen WÄHLT den Baustein aus (kein Ton) und
//!     lädt ihn in das rechte Andock-Feld (BlockDock). Zeigt Id, Name und
//!     schreibgeschützte Status-Chips (Transpose / Loop / Speed).
//!   • TRIGGER-LEISTE (unten, ~40 %): Antippen löst den Baustein aus. Bei den
//!     Lane-Play-Modes „hold"/„oneShot" per Touch-Down/-Up
//!     (`block.press` / `block.release`), sonst per Klick (`block.trigger`).
//!
//! Im Sperr-Modus (lane-lock) fällt der Körper weg — die ganze Kachel ist dann
//! nur noch Trigger. Alle Bearbeitungs-Aktionen (Transpose, Speed, Loop, nach
//! links/rechts schieben, tauschen, editieren, entfernen) sitzen im BlockDock.
//!
//! Laufzeit-Feedback (`play-fill`/`play-glow`, Klassen + `--play`) schreibt die
//! RuntimeFeed pro Frame direkt ins DOM — siehe app/runtime.ts.

import { useEffect, useRef } from "react";
import type { Lane, Block, Slot } from "../../state";
import { useRuntimeTile, useSend } from "../store";

function loopBadge(slot: Slot): string | null {
  if (slot.loopMode === "loop") return "∞";
  if (slot.loopMode === "count") return `×${slot.loopCount ?? 2}`;
  return null;
}

export interface SlotTileProps {
  lane: Lane;
  slot: Slot;
  blk: Block | undefined;
  locked: boolean;
  selected: boolean;
  onSelect: () => void;
}

export function SlotTile({ lane, slot, blk, locked, selected, onSelect }: SlotTileProps) {
  const send = useSend();
  const runtimeRef = useRuntimeTile(lane.id, slot.id);
  const transpose = slot.transpose ?? 0;
  const speed = slot.speed ?? 1;

  // „hold" / „oneShot": die Trigger-Leiste schaltet die (sonst stumme) Lane per
  // Touch scharf. hold hält nur solange gedrückt, oneShot spielt einmal durch.
  const gated = lane.playMode === "hold" || lane.playMode === "oneShot";
  const isHold = lane.playMode === "hold";
  const press = () => send({ t: "block.press", laneId: lane.id, slotId: slot.id });
  const release = () => send({ t: "block.release", laneId: lane.id, slotId: slot.id });

  // Sicherheitsnetz: wird die Kachel gehalten und dann abgeräumt (Screen-Wechsel,
  // Lane gelöscht), sonst bliebe eine "hold"-Lane hängen und würde weiterklingen.
  const heldRef = useRef(false);
  useEffect(() => () => {
    if (heldRef.current) release();
  }, []);

  const endHold = () => {
    if (heldRef.current) {
      heldRef.current = false;
      release();
    }
  };
  const triggerProps = gated
    ? {
        onPointerDown: () => {
          heldRef.current = isHold;
          press();
        },
        onPointerUp: isHold ? endHold : undefined,
        onPointerCancel: isHold ? endHold : undefined,
        onPointerLeave: isHold ? endHold : undefined,
      }
    : { onClick: () => send({ t: "block.trigger", laneId: lane.id, slotId: slot.id }) };

  const idLabel = blk?.slot ? `${blk.slot.row}-${blk.slot.col}` : "?";
  const loop = loopBadge(slot);
  const triggerLabel = gated ? (isHold ? "◉ HOLD" : "▶ ONCE") : "▶";
  const cls = ["slot-tile", locked ? "locked" : "", selected ? "selected" : ""].filter(Boolean).join(" ");

  return (
    <div className={cls} ref={runtimeRef}>
      {/* Wiedergabe-Anzeige: Fortschritts-Sweep + Playhead. */}
      <div className="play-fill" aria-hidden="true" />
      <div className="play-glow" aria-hidden="true" />

      {/* Rasterort klein in der Ecke — nimmt dem Körper keine Höhe. */}
      <span className="slot-id" aria-hidden="true">{idLabel}</span>

      {/* ── Körper: auswählen (kein Ton) ── */}
      {!locked && (
        <button
          type="button"
          className="slot-body"
          title="Select — load this block into the dock (no sound)"
          onClick={onSelect}
        >
          {/* Name groß oben, darunter die Status-Badges. Transpose steht IMMER
              (auch bei 0), Loop-Zähler ist hervorgehoben — s. .slot-meta. */}
          <span className="slot-meta">
            <span className="slot-name">{blk?.name || idLabel}</span>
            <span className="slot-badges">
              <span className="slot-badge transpose-value">
                {transpose > 0 ? `+${transpose}` : transpose < 0 ? `−${-transpose}` : "±0"}
              </span>
              {loop && <span className="slot-badge loop">{loop}</span>}
              {speed !== 1 && <span className="slot-badge">×{speed}</span>}
            </span>
          </span>
        </button>
      )}

      {/* ── Trigger-Leiste: auslösen ── */}
      <button
        type="button"
        className="slot-trigger"
        style={{ color: lane.color || undefined }}
        title={gated ? (isHold ? "Hold to play" : "Tap to play once") : "Tap to trigger"}
        {...triggerProps}
      >
        {triggerLabel}
      </button>
    </div>
  );
}
