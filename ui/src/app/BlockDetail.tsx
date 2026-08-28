//! Baustein-Detail — React-Port von ui/blockdetail.ts. Notes (Melodie) bzw.
//! Steps (Beat/CC/…) editieren. Geöffnet von der Sequencer-Übersicht per
//! langem Druck auf eine Slot-Kachel.

import { useMemo } from "react";
import type { Block, BlockType, Device } from "../state";
import { useSend, useStoreValue, useRuntimeBlock } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";
import { BeatEditor, ChordEditor, ArpEditor, ProgramChangeEditor, PatternShiftEditor } from "./blockdetail/editors";
import { MelodyEditor } from "./blockdetail/MelodyEditor";
import type { StepFlow } from "./blockdetail/StepGrid";
import { useLocalPref } from "./useLocalPref";
import { CcEditor } from "./blockdetail/CcEditor";
import { BlockLengthControls } from "./blockdetail/LengthControls";
import { BlockRuntimeStatus } from "./blockdetail/RuntimeStatus";

interface FoundBlock {
  block: Block;
  device: Device;
}

// Stable reference for the useSyncExternalStore selector below — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_DEVICES: Device[] = [];

export interface BlockDetailProps {
  blockId: string;
  onClose: () => void;
  onMove: (deviceId: string, blockId: string, blockType: BlockType) => void;
}

export function BlockDetail({ blockId, onClose, onMove }: BlockDetailProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  // Derived via useMemo (not directly in the useSyncExternalStore selector)
  // because constructing a fresh `{ block, device }` object on every
  // getSnapshot call would never satisfy Object.is and spin React into an
  // infinite update loop.
  const found = useMemo<FoundBlock | undefined>(() => {
    for (const dev of devices) {
      const block = dev.blocks?.find((b) => b.id === blockId);
      if (block) return { block, device: dev };
    }
    return undefined;
  }, [devices, blockId]);

  return (
    <div style={{ position: "fixed", inset: 0, top: TRANSPORT_H, background: "var(--pal-water-deep)", overflowY: "auto", padding: 16 }}>
      <Button variant="alt" style={{ width: 130, height: 40, fontSize: 17 }} onClick={onClose}>
        ← Back
      </Button>

      {!found ? (
        <div style={{ marginTop: 24, color: "var(--pal-text-dim)", fontSize: 18 }}>Block no longer exists.</div>
      ) : (
        <BlockDetailBody found={found} onClose={onClose} onMove={onMove} openKeyboard={openKeyboard} send={send} />
      )}
    </div>
  );
}

function BlockDetailBody({
  found,
  onClose,
  onMove,
  openKeyboard,
  send,
}: {
  found: FoundBlock;
  onClose: () => void;
  onMove: (deviceId: string, blockId: string, blockType: BlockType) => void;
  openKeyboard: ReturnType<typeof useTouchKeyboard>;
  send: ReturnType<typeof useSend>;
}) {
  const { block, device } = found;
  // Wurzel des Editors: hier hängen die Laufzeit-Klassen und -Variablen, die
  // Status-Chip und Step-Playheads weiter unten per CSS erben (runtime.ts).
  const runtimeRef = useRuntimeBlock(block.id);
  // Ansichts-Vorliebe, kein Projekt-Feld: taktweise untereinander oder eine
  // lange Reihe. Bleibt über Screen-Wechsel hinweg stehen (localStorage).
  const [flow, setFlow] = useLocalPref<StepFlow>("blockdetail.stepFlow", "wrap");

  return (
    <div ref={runtimeRef} className="block-detail">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, margin: "16px 0" }}>
        <div
          style={{ fontSize: 26, fontWeight: 700, cursor: "pointer" }}
          onClick={() =>
            openKeyboard(block.name, 6, (v) => {
              if (v) send({ t: "block.rename", blockId: block.id, name: v });
            })
          }
        >
          {block.name || "(new)"}
        </div>
        <div style={{ fontSize: 13, color: "var(--pal-text-dim)", fontWeight: 600 }}>{block.type.toUpperCase()}</div>

        {/* Raster des Bausteins — Takte und Substeps pro Takt. Gehört zum
            Baustein (nicht zur Lane), gilt also überall, wo er steckt. */}
        <BlockLengthControls block={block} />

        {/* Nur sinnvoll, solange es überhaupt mehr als einen Takt gibt. */}
        {(block.lengthBars ?? 1) > 1 && (
          <Button
            variant="alt"
            style={{ width: 120, height: 40, fontSize: 15 }}
            onClick={() => setFlow(flow === "wrap" ? "scroll" : "wrap")}
          >
            {flow === "wrap" ? "⤶ Bars" : "⟷ One row"}
          </Button>
        )}

        {/* Kein Kanal-Button mehr: ein Baustein ist reiner Inhalt und kann in
            mehreren Lanes stecken — Kanal (und bei CC das Ziel) setzt die Lane
            in der Sequencer-Übersicht, sonst würde ein Baustein-Override
            stillschweigend auch alle anderen Lanes umbiegen. */}

        {/* Move — changes the block's library slot (its ID, e.g. "3-5"), so
            it hands off to the Block Library grid to pick a free target cell. */}
        <Button
          variant="alt"
          style={{ width: 100, height: 40, fontSize: 15, marginLeft: "auto" }}
          onClick={() => {
            onClose();
            onMove(device.id, block.id, block.type as BlockType);
          }}
        >
          ⇄ Move
        </Button>
        <Button
          variant="danger"
          style={{ width: 100, height: 40, fontSize: 15 }}
          onClick={() => {
            send({ t: "block.delete", blockId: block.id });
            onClose();
          }}
        >
          ✕ Delete
        </Button>
      </div>

      <BlockRuntimeStatus block={block} />

      {block.type === "melody" && <MelodyEditor block={block} flow={flow} />}
      {block.type === "beat" && <BeatEditor block={block} flow={flow} />}
      {block.type === "chord" && <ChordEditor block={block} flow={flow} />}
      {block.type === "arp" && <ArpEditor block={block} />}
      {block.type === "cc" && <CcEditor block={block} flow={flow} />}
      {block.type === "programChange" && <ProgramChangeEditor block={block} flow={flow} />}
      {block.type === "patternShift" && <PatternShiftEditor block={block} flow={flow} />}
    </div>
  );
}
