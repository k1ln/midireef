//! Sequencer-Overview-Popups — React-Port der openXPicker()/showPopupMenu()
//! Paare aus ui/overview.ts. Jede nutzt den gemeinsamen <Popup>-Rahmen
//! (Backdrop + Box, native Scroll statt Drag-Hack).

import type { Device, Lane, Block } from "../../state";
import { useSend, useStoreValue } from "../store";
import type { LiveControl } from "../dashboard/ControlWidget";
import { Popup } from "../widgets/Popup";
import { Button } from "../widgets/Button";

// Stable reference for the useSyncExternalStore selector — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_CONTROLS: LiveControl[] = [];
const EMPTY_BLOCKS: Block[] = [];

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

/**
 * CC-Lane: Ziel-Knob wählen. Angeboten werden NUR gelernte Knobs, die zu genau
 * diesem Gerät gehören und ein CC-Mapping haben — alles andere wäre nicht
 * verbunden und würde beim Abspielen verworfen (siehe `resolve_cc_target` in
 * engine.rs). Das Ziel sitzt an der Lane, nicht am Baustein: derselbe
 * Bewegungs-Baustein soll in mehreren Lanes auf verschiedene CCs gehen können.
 */
export function CcTargetPickerPopup({ lane, dev, onClose }: { lane: Lane; dev: Device; onClose: () => void }) {
  const send = useSend();
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const knobs = controls.filter(
    (c) => c.kind === "knob" && c.deviceId === dev.id && c.mapping?.kind === "cc",
  );

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">CC target — {dev.name}</div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 12 }}>
        The blocks in this lane supply the movement; this knob picks the CC number. The channel comes from the
        lane (currently Ch {lane.channel}).
      </div>
      {knobs.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>
          No knobs learned for this device yet — turn one on the device with MIDI-Learn armed on the Dashboard.
        </div>
      ) : (
        knobs.map((k) => (
          <Button
            key={k.id}
            variant={lane.ccControlId === k.id ? "active" : "default"}
            className="popup-row"
            style={{ height: 44, marginBottom: 8 }}
            onClick={() => {
              onClose();
              send({ t: "lane.setCcControl", laneId: lane.id, controlId: k.id });
            }}
          >
            {k.name || "(unnamed)"} — CC{k.mapping?.number}
          </Button>
        ))
      )}
      {lane.ccControlId && (
        <Button
          variant="danger"
          className="popup-row"
          onClick={() => {
            onClose();
            send({ t: "lane.setCcControl", laneId: lane.id, controlId: null });
          }}
        >
          Clear target
        </Button>
      )}
    </Popup>
  );
}

/** "＋" auf einer Lane: neu anlegen ODER einen vorhandenen Baustein
 *  (gleicher Typ, noch nicht in dieser Lane) per ID auswählen. */
export function AddBlockPickerPopup({ lane, onClose }: { lane: Lane; onClose: () => void }) {
  const send = useSend();
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const existing = blocks.filter(
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
  slotId,
  currentBlockId,
  onClose,
}: {
  lane: Lane;
  slotId: string;
  currentBlockId: string;
  onClose: () => void;
}) {
  const send = useSend();
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const candidates = blocks.filter(
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

