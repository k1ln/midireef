//! Block Library — React-Port von ui/blocklibrary.ts: die 9×9 Tabelle pro
//! Baustein-Typ (architecture doc §4). Ein Tab pro Typ; leere Zelle tippen
//! legt EXAKT an dieser Stelle einen Baustein an; belegte Zelle tippen
//! öffnet den Editor.

import { useState, type CSSProperties } from "react";
import type { Block, BlockType, Device } from "../state";
import { useSend, useStoreValue } from "./store";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";

const TYPES: { type: BlockType; label: string }[] = [
  { type: "melody", label: "Melody" },
  { type: "beat", label: "Beat" },
  { type: "cc", label: "CC" },
  { type: "programChange", label: "Prog" },
  { type: "patternShift", label: "Pattern" },
  { type: "chord", label: "Chord" },
  { type: "arp", label: "Arp" },
];

export interface BlockLibraryProps {
  deviceId: string;
  initialType?: BlockType;
  initialMovingBlockId?: string;
  onClose: () => void;
  onOpenBlock: (blockId: string) => void;
}

export function BlockLibrary({ deviceId, initialType, initialMovingBlockId, onClose, onOpenBlock }: BlockLibraryProps) {
  const send = useSend();
  const device = useStoreValue((s): Device | undefined => s.project?.devices.find((d) => d.id === deviceId));
  const [activeType, setActiveType] = useState<BlockType>(initialType ?? "melody");
  const [movingBlockId, setMovingBlockId] = useState<string | undefined>(initialMovingBlockId);

  return (
    <div style={{ position: "fixed", inset: 0, top: TRANSPORT_H, background: "var(--pal-water-deep)", overflowY: "auto", padding: 16 }}>
      <Button variant="alt" style={{ width: 130, height: 40, fontSize: 17 }} onClick={onClose}>
        ← Back
      </Button>

      {!device ? (
        <div style={{ marginTop: 24, color: "var(--pal-text-dim)", fontSize: 18 }}>Device no longer exists.</div>
      ) : (
        <>
          <div style={{ fontSize: 22, fontWeight: 700, margin: "20px 0 12px" }}>{device.name} — Block Library</div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
            {TYPES.map((t) => (
              <Button
                key={t.type}
                variant={t.type === activeType ? "active" : "default"}
                style={{ width: 88, height: 34, fontSize: 14 }}
                onClick={() => setActiveType(t.type)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          <BlockGrid
            device={device}
            activeType={activeType}
            movingBlockId={movingBlockId}
            onArmMove={setMovingBlockId}
            onCancelMove={() => setMovingBlockId(undefined)}
            onOpenBlock={onOpenBlock}
            send={send}
          />
        </>
      )}
    </div>
  );
}

function BlockGrid({
  device,
  activeType,
  movingBlockId,
  onArmMove,
  onCancelMove,
  onOpenBlock,
  send,
}: {
  device: Device;
  activeType: BlockType;
  movingBlockId: string | undefined;
  onArmMove: (blockId: string) => void;
  onCancelMove: () => void;
  onOpenBlock: (blockId: string) => void;
  send: ReturnType<typeof useSend>;
}) {
  const blocks = (device.blocks ?? []).filter((b) => b.type === activeType);
  const moving = movingBlockId ? blocks.find((b) => b.id === movingBlockId) : undefined;
  const cell = 74;
  const gap = 6;

  const rows: (Block | undefined)[][] = [];
  for (let row = 1; row <= 9; row++) {
    const r: (Block | undefined)[] = [];
    for (let col = 1; col <= 9; col++) {
      r.push(blocks.find((b) => b.slot && b.slot.row === row && b.slot.col === col));
    }
    rows.push(r);
  }

  return (
    <div style={{ maxWidth: 9 * cell + 8 * gap }}>
      {moving && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--pal-btn-alt)",
            borderRadius: 8,
            padding: "6px 10px",
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Moving “{moving.name}” — tap a free cell</span>
          <Button variant="danger" style={{ width: 90, height: 26, fontSize: 13 }} onClick={onCancelMove}>
            Cancel
          </Button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(9, ${cell}px)`, gap }}>
        {rows.map((r, ri) =>
          r.map((blk, ci) => (
            <SlotCell
              key={`${ri}-${ci}`}
              row={ri + 1}
              col={ci + 1}
              size={cell}
              blk={blk}
              movingBlockId={movingBlockId}
              onTap={() => {
                if (movingBlockId) {
                  if (!blk) send({ t: "block.move", blockId: movingBlockId, row: ri + 1, col: ci + 1 });
                  onCancelMove();
                  return;
                }
                if (blk) onOpenBlock(blk.id);
                else send({ t: "block.createAt", deviceId: device.id, blockType: activeType, row: ri + 1, col: ci + 1 });
              }}
              onArmMove={() => blk && onArmMove(blk.id)}
              onDelete={() => blk && send({ t: "block.delete", blockId: blk.id })}
            />
          )),
        )}
      </div>
    </div>
  );
}

function SlotCell({
  row,
  col,
  size,
  blk,
  movingBlockId,
  onTap,
  onArmMove,
  onDelete,
}: {
  row: number;
  col: number;
  size: number;
  blk: Block | undefined;
  movingBlockId: string | undefined;
  onTap: () => void;
  onArmMove: () => void;
  onDelete: () => void;
}) {
  const dropTarget = !!movingBlockId && !blk;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: 8,
        cursor: "pointer",
        background: dropTarget ? "rgba(240, 240, 240, 0.35)" : blk ? "var(--pal-btn)" : "var(--pal-panel-deep)",
        border: dropTarget
          ? "2px solid var(--pal-btn-active)"
          : `1px solid rgba(255, 255, 255, ${blk ? 0.3 : 0.15})`,
        opacity: blk ? 0.95 : 0.5,
      }}
      onClick={onTap}
    >
      <span style={{ position: "absolute", top: 3, left: 4, fontSize: 9, color: "var(--pal-text-dim)" }}>
        {row}-{col}
      </span>
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, calc(-50% + 4px))",
          fontSize: blk ? 13 : 20,
          fontWeight: blk ? 700 : 400,
          color: blk ? "var(--pal-text)" : "var(--pal-text-dim)",
        }}
      >
        {blk ? blk.name || "?" : "+"}
      </span>

      {blk && !movingBlockId && (
        <>
          <button
            type="button"
            aria-label="Move"
            style={badgeStyle(4, "var(--pal-btn-alt)")}
            onClick={(e) => {
              e.stopPropagation();
              onArmMove();
            }}
          >
            ⇄
          </button>
          <button
            type="button"
            aria-label="Delete"
            style={badgeStyle(size - 24, "var(--pal-danger)")}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

function badgeStyle(left: number, background: string): CSSProperties {
  return {
    position: "absolute",
    top: 2,
    left,
    width: 20,
    height: 20,
    borderRadius: "50%",
    background,
    color: "var(--pal-white)",
    fontSize: 10,
    fontWeight: 700,
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}
