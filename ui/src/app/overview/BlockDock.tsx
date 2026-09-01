//! Angedocktes Bearbeitungs-Feld (rechte Seite der Sequencer-Übersicht).
//!
//! Fester Ort, kein Menü-Tauchen: eine Kachel im KÖRPER antippen wählt ihren
//! Baustein aus, hier stehen sofort seine Werte — Transpose, Speed, Repeat als
//! Dropdown (öffnet beim aktuellen Wert, s. SelectMenu), dazu nach links/rechts
//! schieben, tauschen, editieren, aus der Lane entfernen. Mit ⚑ bleibt das
//! Feld auf DIESEM Baustein, während man weiter andere Kacheln triggert.
//!
//! Bewusst schmal: Zielgerät ist ein 7"-Raspi-Display (800×480) — die Spalte
//! darf dem Kachel-Raster kaum Platz wegnehmen.

import { useState } from "react";
import type { Lane, Block, Slot } from "../../state";
import { useSend } from "../store";
import { useTouchKeyboard } from "../TouchKeyboard";
import { Button } from "../widgets/Button";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { TRANSPORT_H } from "../layout";

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const SPEED_OPTIONS: SelectOption<number>[] = SPEED_PRESETS.map((s) => ({ value: s, label: `×${s}` }));

// Transpose: wie eine Tonhöhen-Achse — nach OBEN aufwärts (+36 … +1), in der
// MITTE die 0, nach UNTEN abwärts (−1 … −36). SelectMenu öffnet die Liste beim
// laufenden Wert, bei 0 also genau in der Mitte.
const TRANSPOSE_OPTIONS: SelectOption<number>[] = [
  ...Array.from({ length: 36 }, (_, i) => ({ value: 36 - i, label: `+${36 - i}` })),
  { value: 0, label: "0" },
  ...Array.from({ length: 36 }, (_, i) => ({ value: -(i + 1), label: `−${i + 1}` })),
];

// Repeat: 0 = einmal (Lane läuft weiter), 1–24 = Zähl-Loop, ∞ = endlos.
const REPEAT_INFINITE = 999;
const REPEAT_OPTIONS: SelectOption<number>[] = [
  ...Array.from({ length: 25 }, (_, n) => ({ value: n, label: n === 0 ? "0" : `×${n}` })),
  { value: REPEAT_INFINITE, label: "∞" },
];

function repeatValue(slot: Slot): number {
  if (slot.loopMode === "loop") return REPEAT_INFINITE;
  if (slot.loopMode === "count") return slot.loopCount ?? 2;
  return 0;
}
function repeatLabel(v: number): string {
  if (v === REPEAT_INFINITE) return "∞";
  if (v <= 0) return "0";
  return `×${v}`;
}
function repeatCommand(v: number): { loop: string; count?: number } {
  if (v === REPEAT_INFINITE) return { loop: "loop" };
  if (v <= 0) return { loop: "off" };
  return { loop: "count", count: v };
}

export interface BlockDockProps {
  lane: Lane;
  slot: Slot;
  blk: Block | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onEdit: () => void;
  onSwap: () => void;
}

export function BlockDock({ lane, slot, blk, pinned, onTogglePin, onClose, onEdit, onSwap }: BlockDockProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const transpose = slot.transpose ?? 0;
  const speed = slot.speed ?? 1;
  const repeat = repeatValue(slot);

  const slotIds = (lane.slots ?? []).map((s) => s.id);
  const idx = slotIds.indexOf(slot.id);
  const canLeft = idx > 0;
  const canRight = idx >= 0 && idx < slotIds.length - 1;

  const move = (dir: 1 | -1) => {
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= slotIds.length) return;
    const next = slotIds.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    send({ t: "laneSlot.reorder", laneId: lane.id, orderedSlotIds: next });
  };

  const idLabel = blk?.slot ? `${blk.slot.row}-${blk.slot.col}` : "?";

  return (
    <div className="block-dock" style={{ top: TRANSPORT_H }}>
      <button
        type="button"
        className="block-dock-name"
        title="Rename this block"
        onClick={() =>
          blk &&
          openKeyboard(blk.name ?? "", 6, (v) => {
            if (v) send({ t: "block.rename", blockId: blk.id, name: v });
          })
        }
      >
        {blk?.name || idLabel}
      </button>

      <div className="block-dock-head">
        <span className="block-dock-sub">{idLabel}</span>
        <Button
          variant={pinned ? "active" : "alt"}
          className="block-dock-icon"
          title={pinned ? "Unpin — dock follows your next selection" : "Pin — keep this block while you trigger others"}
          onClick={onTogglePin}
        >
          ⚑
        </Button>
        <Button variant="alt" className="block-dock-icon" title="Close" onClick={onClose}>
          ✕
        </Button>
      </div>

      <div className="block-dock-field">
        <div className="block-dock-label">Transpose</div>
        <SelectMenu
          variant="alt"
          className="block-dock-select"
          title="Transpose (semitones)"
          buttonTitle="Transpose this block in semitones"
          buttonLabel={transpose > 0 ? `+${transpose}` : transpose < 0 ? `−${-transpose}` : "0"}
          value={transpose}
          options={TRANSPOSE_OPTIONS}
          onChange={(v) => send({ t: "block.setTranspose", laneId: lane.id, slotId: slot.id, transpose: v })}
        />
      </div>

      <div className="block-dock-field">
        <div className="block-dock-label">Speed</div>
        <SelectMenu
          variant="alt"
          className="block-dock-select"
          title="Speed"
          buttonTitle="Playback speed of this block"
          buttonLabel={`×${speed}`}
          value={speed}
          options={SPEED_OPTIONS}
          onChange={(v) => send({ t: "block.setSpeed", laneId: lane.id, slotId: slot.id, speed: v })}
        />
      </div>

      <div className="block-dock-field">
        <div className="block-dock-label">Repeat</div>
        <SelectMenu
          variant="alt"
          className="block-dock-select"
          title="Repeat"
          buttonTitle="How often this block repeats before the lane moves on"
          buttonLabel={repeatLabel(repeat)}
          value={repeat}
          options={REPEAT_OPTIONS}
          onChange={(v) => {
            const c = repeatCommand(v);
            send({ t: "block.setLoop", laneId: lane.id, slotId: slot.id, loop: c.loop, count: c.count });
          }}
        />
      </div>

      <div className="block-dock-field">
        <div className="block-dock-label">Move</div>
        <div className="block-dock-move">
          <Button variant="alt" onClick={() => move(-1)} disabled={!canLeft} title="Move left">
            ◀
          </Button>
          <div className="block-dock-pos">{idx >= 0 ? idx + 1 : "–"}</div>
          <Button variant="alt" onClick={() => move(1)} disabled={!canRight} title="Move right">
            ▶
          </Button>
        </div>
      </div>

      <Button variant="alt" className="block-dock-action" onClick={onEdit} disabled={!blk} title="Edit this block">
        ✎ Edit
      </Button>
      <Button
        variant="alt"
        className="block-dock-action"
        onClick={onSwap}
        disabled={!blk}
        title="Swap this slot to another block"
      >
        ⇄ Swap
      </Button>
      <Button
        variant="danger"
        className="block-dock-action"
        onClick={() => setConfirmRemove(true)}
        title="Remove this block from the lane"
      >
        ✕ Delete
      </Button>

      {confirmRemove && (
        <div className="block-dock-confirm">
          <span>Remove from lane?</span>
          <div className="block-dock-actions">
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                onClose();
                send({ t: "laneSlot.remove", laneId: lane.id, slotId: slot.id });
              }}
            >
              Remove
            </Button>
            <Button variant="alt" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
