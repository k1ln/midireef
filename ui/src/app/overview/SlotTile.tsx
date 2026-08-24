//! Quadratische Slot-Kachel — React-Port des slotTile() aus ui/overview.ts.
//! Oberer Streifen = Tap (trigger) / Long-Press (Kontextmenü, via onLongPress
//! an Overview delegiert); darunter Transpose-Stepper, Speed (links) und
//! Repeat + Delete (rechts) — alles per Slot, direkt in der Lane bedienbar.

import type { Lane, Block, Slot } from "../../state";
import { useSend } from "../store";
import { Button } from "../widgets/Button";
import { useLongPress } from "../useLongPress";

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16];

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

function loopLabel(slot: Slot): string {
  if (slot.loopMode === "loop") return "∞";
  if (slot.loopMode === "count") return `×${slot.loopCount ?? 2}`;
  return "1×";
}

function nextLoopStep(slot: Slot): { mode: string; count?: number } {
  const i = LOOP_STEPS.findIndex(
    (s) => s.mode === slot.loopMode && (s.mode !== "count" || s.count === (slot.loopCount ?? 2)),
  );
  return LOOP_STEPS[(i + 1) % LOOP_STEPS.length];
}

export interface SlotTileProps {
  lane: Lane;
  slot: Slot;
  blk: Block | undefined;
  onLongPress: () => void;
}

export function SlotTile({ lane, slot, blk, onLongPress }: SlotTileProps) {
  const send = useSend();
  const transpose = slot.transpose ?? 0;
  const speed = slot.speed ?? 1;

  const idStripProps = useLongPress(onLongPress, () =>
    send({ t: "block.trigger", laneId: lane.id, slotId: slot.id }),
  );

  return (
    <div className="slot-tile">
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

      <div className="id-strip" style={{ color: lane.color || undefined }} {...idStripProps}>
        {blk?.slot ? `${blk.slot.row}-${blk.slot.col}` : "?"}
      </div>

      <div className="transpose-row">
        <Button
          style={{ width: 30, height: 26, fontSize: 15 }}
          onClick={() => send({ t: "block.setTranspose", laneId: lane.id, slotId: slot.id, transpose: transpose - 1 })}
        >
          –
        </Button>
        <span className="transpose-value">{transpose > 0 ? `+${transpose}` : transpose}</span>
        <Button
          style={{ width: 30, height: 26, fontSize: 15 }}
          onClick={() => send({ t: "block.setTranspose", laneId: lane.id, slotId: slot.id, transpose: transpose + 1 })}
        >
          +
        </Button>
      </div>

      <div className="bottom-row">
        <Button
          variant="alt"
          className="speed-btn"
          onClick={() => {
            const i = SPEED_PRESETS.indexOf(speed);
            const next = SPEED_PRESETS[(i < 0 ? 2 : i + 1) % SPEED_PRESETS.length];
            send({ t: "block.setSpeed", laneId: lane.id, slotId: slot.id, speed: next });
          }}
        >
          ×{speed}
        </Button>
        <Button
          variant="alt"
          className={slot.loopMode === "loop" ? "loop-btn loop-on" : "loop-btn"}
          onClick={() => {
            const next = nextLoopStep(slot);
            send({ t: "block.setLoop", laneId: lane.id, slotId: slot.id, loop: next.mode, count: next.count });
          }}
        >
          {loopLabel(slot)}
        </Button>
      </div>
    </div>
  );
}
