//! Baustein-Detail — React-Port von ui/blockdetail.ts. Notes (Melodie) bzw.
//! Steps (Beat/CC/…) editieren. Geöffnet von der Sequencer-Übersicht per
//! langem Druck auf eine Slot-Kachel.

import { useMemo } from "react";
import type { Block, BlockType, Device } from "../state";
import { useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";
import { MelodyEditor, BeatEditor, ChordEditor, ArpEditor, ProgramChangeEditor, PatternShiftEditor } from "./blockdetail/editors";
import { CcEditor } from "./blockdetail/CcEditor";

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
  const chLabel = block.channel ? `Ch ${block.channel}` : `Ch: Device (${device.channel})`;

  return (
    <div>
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

        <Button
          style={{ width: 168, height: 30, fontSize: 13 }}
          onClick={() => {
            const next = block.channel === undefined ? 1 : block.channel >= 16 ? undefined : block.channel + 1;
            send({ t: "block.setField", blockId: block.id, field: "channel", value: next ?? null });
          }}
        >
          {chLabel}
        </Button>

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

      {block.type === "melody" && <MelodyEditor block={block} />}
      {block.type === "beat" && <BeatEditor block={block} />}
      {block.type === "chord" && <ChordEditor block={block} />}
      {block.type === "arp" && <ArpEditor block={block} />}
      {block.type === "cc" && <CcEditor block={block} />}
      {block.type === "programChange" && <ProgramChangeEditor block={block} />}
      {block.type === "patternShift" && <PatternShiftEditor block={block} />}
    </div>
  );
}
