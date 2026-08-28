//! Quadratische Slot-Kachel — React-Port des slotTile() aus ui/overview.ts.
//! Oberer Streifen = Tap (trigger) / Long-Press (Kontextmenü, via onLongPress
//! an Overview delegiert); darunter Transpose-Stepper, Speed (links) und
//! Repeat + Delete (rechts) — alles per Slot, direkt in der Lane bedienbar.
//!
//! Laufzeit-Feedback (`play-fill`/`play-glow`, Klassen + `--play`) kommt nicht
//! aus dem Render, sondern wird von der RuntimeFeed pro Frame direkt ins DOM
//! geschrieben — siehe app/runtime.ts.

import type { Lane, Block, Slot } from "../../state";
import { useRuntimeTile, useSend } from "../store";
import { Button } from "../widgets/Button";
import { SelectMenu, type SelectOption } from "../widgets/SelectMenu";
import { useLongPress } from "../useLongPress";

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const SPEED_OPTIONS: SelectOption<number>[] = SPEED_PRESETS.map((s) => ({ value: s, label: `×${s}` }));

// Repeat-Zyklus: 1× (kein Loop) → ∞ (endlos) → ×2…×8 (Zähl-Loop). Deckt sich
// mit LoopMode/loopCount im Modell.
const LOOP_STEPS: { mode: string; count?: number; label: string }[] = [
  { mode: "off", label: "1×" },
  { mode: "loop", label: "∞" },
  { mode: "count", count: 2, label: "×2" },
  { mode: "count", count: 3, label: "×3" },
  { mode: "count", count: 4, label: "×4" },
  { mode: "count", count: 8, label: "×8" },
];
const LOOP_OPTIONS: SelectOption<number>[] = LOOP_STEPS.map((s, i) => ({ value: i, label: s.label }));

function loopLabel(slot: Slot): string {
  if (slot.loopMode === "loop") return "∞";
  if (slot.loopMode === "count") return `×${slot.loopCount ?? 2}`;
  return "1×";
}

function currentLoopIndex(slot: Slot): number {
  const i = LOOP_STEPS.findIndex(
    (s) => s.mode === slot.loopMode && (s.mode !== "count" || s.count === (slot.loopCount ?? 2)),
  );
  return i < 0 ? 0 : i;
}

export interface SlotTileProps {
  lane: Lane;
  slot: Slot;
  blk: Block | undefined;
  locked: boolean;
  onLongPress: () => void;
}

export function SlotTile({ lane, slot, blk, locked, onLongPress }: SlotTileProps) {
  const send = useSend();
  const runtimeRef = useRuntimeTile(lane.id, slot.id);
  const transpose = slot.transpose ?? 0;
  const speed = slot.speed ?? 1;

  // Im Sperr-Modus bleibt nur das Antippen (Block auslösen) übrig — das lange
  // Drücken (Kontextmenü mit Löschen/Tauschen) ist aus, damit während einer
  // Live-Performance kein Fehlgriff etwas verstellt.
  const idStripProps = useLongPress(
    locked ? () => {} : onLongPress,
    () => send({ t: "block.trigger", laneId: lane.id, slotId: slot.id }),
  );

  return (
    <div className="slot-tile" ref={runtimeRef}>
      {/* Wiedergabe-Anzeige: Fortschritts-Sweep + Playhead, darüber der Rahmen,
          der am Blockstart anblitzt und am Blockende ausblendet. */}
      <div className="play-fill" aria-hidden="true" />
      <div className="play-glow" aria-hidden="true" />

      {!locked && (
        <Button
          variant="danger"
          className="delete-badge"
          onClick={() => {
            if (blk) send({ t: "block.delete", blockId: blk.id });
            else send({ t: "laneSlot.remove", laneId: lane.id, slotId: slot.id });
          }}
        >
          ✕
        </Button>
      )}

      <div className="id-strip" style={{ color: lane.color || undefined }} {...idStripProps}>
        {blk?.slot ? `${blk.slot.row}-${blk.slot.col}` : "?"}
      </div>

      <div className="transpose-row">
        <Button
          style={{ width: 52, height: 52, fontSize: 22 }}
          disabled={locked}
          onClick={() => send({ t: "block.setTranspose", laneId: lane.id, slotId: slot.id, transpose: transpose - 1 })}
        >
          –
        </Button>
        <span className="transpose-value">{transpose > 0 ? `+${transpose}` : transpose}</span>
        <Button
          style={{ width: 52, height: 52, fontSize: 22 }}
          disabled={locked}
          onClick={() => send({ t: "block.setTranspose", laneId: lane.id, slotId: slot.id, transpose: transpose + 1 })}
        >
          +
        </Button>
      </div>

      <div className="bottom-row">
        <SelectMenu
          variant="alt"
          className="speed-btn"
          title="Speed"
          buttonLabel={`×${speed}`}
          buttonTitle="Playback speed of this block"
          disabled={locked}
          value={speed}
          options={SPEED_OPTIONS}
          onChange={(next) => send({ t: "block.setSpeed", laneId: lane.id, slotId: slot.id, speed: next })}
        />
        <SelectMenu
          variant="alt"
          className={slot.loopMode === "loop" ? "loop-btn loop-on" : "loop-btn"}
          title="Repeat"
          buttonLabel={loopLabel(slot)}
          buttonTitle="How often this block repeats before the lane moves on"
          disabled={locked}
          value={currentLoopIndex(slot)}
          options={LOOP_OPTIONS}
          onChange={(i) => {
            const step = LOOP_STEPS[i];
            send({ t: "block.setLoop", laneId: lane.id, slotId: slot.id, loop: step.mode, count: step.count });
          }}
        />
      </div>
    </div>
  );
}
