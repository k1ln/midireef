//! Sequencer-Overview-Popups — React-Port der openXPicker()/showPopupMenu()
//! Paare aus ui/overview.ts. Jede nutzt den gemeinsamen <Popup>-Rahmen
//! (Backdrop + Box, native Scroll statt Drag-Hack).

import type { Device, Lane, Block } from "../../state";
import { useSend, useStoreValue } from "../store";
import { Popup } from "../widgets/Popup";
import { Button } from "../widgets/Button";

export const ROLES: { role: string; label: string }[] = [
  { role: "melody", label: "Melody" },
  { role: "beat", label: "Beat" },
  { role: "cc", label: "CC" },
  { role: "programChange", label: "Prog" },
  { role: "patternShift", label: "Pattern" },
  { role: "chord", label: "Chord" },
  { role: "arp", label: "Arp" },
];

export function roleLabel(role: string): string {
  return ROLES.find((r) => r.role === role)?.label ?? role;
}

/** Legt ein Device für einen gefundenen MIDI-Ausgang an. */
export function PortPickerPopup({ onClose }: { onClose: () => void }) {
  const send = useSend();
  const ports = useStoreValue((s) => s.midiOutputs);
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Choose MIDI output</div>
      {ports.map((portName) => (
        <Button
          key={portName}
          className="popup-row"
          onClick={() => {
            send({ t: "device.create", name: portName, midiOutPort: portName });
            onClose();
          }}
        >
          {portName}
        </Button>
      ))}
    </Popup>
  );
}

export function RolePickerPopup({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const send = useSend();
  return (
    <Popup onClose={onClose} boxStyle={{ width: 440 }}>
      <div className="popup-title">Choose lane type</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {ROLES.map((r) => (
          <Button
            key={r.role}
            style={{ height: 60 }}
            onClick={() => {
              send({ t: "lane.create", deviceId, role: r.role });
              onClose();
            }}
          >
            {r.label}
          </Button>
        ))}
      </div>
    </Popup>
  );
}

/** "＋" auf einer Lane: neu anlegen ODER einen vorhandenen Baustein
 *  (gleicher Typ, noch nicht in dieser Lane) per ID auswählen. */
export function AddBlockPickerPopup({ lane, dev, onClose }: { lane: Lane; dev: Device; onClose: () => void }) {
  const send = useSend();
  const existing = (dev.blocks ?? []).filter(
    (b) => b.type === lane.role && !lane.slots.some((s) => s.blockId === b.id),
  );
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add block</div>
      <Button
        variant="alt"
        className="popup-row"
        onClick={() => {
          send({ t: "lane.addBlock", laneId: lane.id });
          onClose();
        }}
      >
        ＋ New block
      </Button>
      {existing.map((b) => {
        const slotLabel = b.slot ? `${b.slot.row}-${b.slot.col}` : "?";
        return (
          <Button
            key={b.id}
            className="popup-row"
            onClick={() => {
              send({ t: "laneSlot.add", laneId: lane.id, blockId: b.id });
              onClose();
            }}
          >
            {slotLabel} {b.name || "?"}
          </Button>
        );
      })}
    </Popup>
  );
}

/** "⇄" / Swap block: tauscht den Slot auf einen anderen bestehenden
 *  Baustein — der Slot selbst (Transpose/Speed/Loop-Mode) bleibt erhalten. */
export function SwapPickerPopup({
  lane,
  dev,
  slotId,
  currentBlockId,
  onClose,
}: {
  lane: Lane;
  dev: Device;
  slotId: string;
  currentBlockId: string;
  onClose: () => void;
}) {
  const send = useSend();
  const candidates = (dev.blocks ?? []).filter(
    (b) => b.type === lane.role && b.id !== currentBlockId && !lane.slots.some((s) => s.blockId === b.id),
  );
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Swap block</div>
      {candidates.length === 0 && (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No other blocks of this type yet.</div>
      )}
      {candidates.map((b) => {
        const slotLabel = b.slot ? `${b.slot.row}-${b.slot.col}` : "?";
        return (
          <Button
            key={b.id}
            className="popup-row"
            onClick={() => {
              send({ t: "laneSlot.setBlock", laneId: lane.id, slotId, blockId: b.id });
              onClose();
            }}
          >
            {slotLabel} {b.name || "?"}
          </Button>
        );
      })}
    </Popup>
  );
}

/** Long-Press auf eine Slot-Kachel: Kontextmenü statt Direkt-Aktion. */
export function BlockContextMenuPopup({
  lane,
  slotId,
  blk,
  onClose,
  onOpenBlock,
  onSwap,
}: {
  lane: Lane;
  slotId: string;
  blk: Block | undefined;
  onClose: () => void;
  onOpenBlock: (blockId: string) => void;
  onSwap: () => void;
}) {
  const send = useSend();
  const title = blk ? `Block ${blk.slot ? `${blk.slot.row}-${blk.slot.col}` : blk.name || "?"}` : "Block";
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">{title}</div>
      {blk ? (
        <>
          <Button
            className="popup-row"
            onClick={() => {
              onClose();
              onOpenBlock(blk.id);
            }}
          >
            Edit
          </Button>
          <Button className="popup-row" onClick={onSwap}>
            Swap block
          </Button>
          <Button
            variant="danger"
            className="popup-row"
            onClick={() => {
              onClose();
              send({ t: "block.delete", blockId: blk.id });
            }}
          >
            Delete
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          className="popup-row"
          onClick={() => {
            onClose();
            send({ t: "laneSlot.remove", laneId: lane.id, slotId });
          }}
        >
          Remove from lane
        </Button>
      )}
    </Popup>
  );
}
