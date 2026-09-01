//! Block Library — React-Port von ui/blocklibrary.ts: die 9×9 Tabelle pro
//! Baustein-Typ (architecture doc §4). Ein Tab pro Typ; leere Zelle tippen
//! legt EXAKT an dieser Stelle einen Baustein an; belegte Zelle tippen
//! öffnet den Editor.
//!
//! Die Bibliothek ist projektweit (nicht mehr pro Device): ein Baustein ist
//! reiner Inhalt und in jeder Lane jedes Geräts einsetzbar — das Ziel
//! (Kanal/CC) legt die Lane fest.

import { useState, type CSSProperties } from "react";
import type { Block, BlockType } from "../state";
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

const EMPTY_BLOCKS: Block[] = [];

export interface BlockLibraryProps {
  initialType?: BlockType;
  initialMovingBlockId?: string;
  onOpenBlock: (blockId: string) => void;
}

export function BlockLibrary({ initialType, initialMovingBlockId, onOpenBlock }: BlockLibraryProps) {
  const send = useSend();
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const [activeType, setActiveType] = useState<BlockType>(initialType ?? "melody");
  const [movingBlockId, setMovingBlockId] = useState<string | undefined>(initialMovingBlockId);

  return (
    // A plain top-level page — same shape as Dashboard / Sequencer: full-bleed
    // below the transport bar, transparent so the scene shows through, no
    // frame and no back button. You leave it from the transport bar.
    <div
      style={{
        position: "fixed",
        top: TRANSPORT_H,
        left: 0,
        right: 0,
        bottom: 0,
        overflowY: "auto",
        padding: 16,
      }}
    >
      <div className="popup-title">Block Library</div>

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
        blocks={blocks}
        activeType={activeType}
        movingBlockId={movingBlockId}
        onArmMove={setMovingBlockId}
        onCancelMove={() => setMovingBlockId(undefined)}
        onOpenBlock={onOpenBlock}
        send={send}
      />
    </div>
  );
}

function BlockGrid({
  blocks: allBlocks,
  activeType,
  movingBlockId,
  onArmMove,
  onCancelMove,
  onOpenBlock,
  send,
}: {
  blocks: Block[];
  activeType: BlockType;
  movingBlockId: string | undefined;
  onArmMove: (blockId: string) => void;
  onCancelMove: () => void;
  onOpenBlock: (blockId: string) => void;
  send: ReturnType<typeof useSend>;
}) {
  const blocks = allBlocks.filter((b) => b.type === activeType);
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
                else send({ t: "block.createAt", blockType: activeType, row: ri + 1, col: ci + 1 });
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
  const [confirming, setConfirming] = useState(false);

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
      <span
        style={{
          position: "absolute",
          bottom: 3,
          left: 5,
          fontSize: 12,
          fontWeight: 700,
          color: blk ? "var(--pal-text)" : "var(--pal-text-dim)",
        }}
      >
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

      {blk && !movingBlockId && !confirming && (
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
              setConfirming(true);
            }}
          >
            ✕
          </button>
        </>
      )}

      {blk && confirming && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background: "rgba(0, 0, 0, 0.82)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: 4,
            zIndex: 2,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center" }}>Delete block?</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={{ ...badgeCenter, background: "var(--pal-danger)" }}
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(false);
                onDelete();
              }}
            >
              ✓
            </button>
            <button
              type="button"
              style={{ ...badgeCenter, background: "var(--pal-btn-alt)" }}
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(false);
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const badgeCenter: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  color: "var(--pal-white)",
  fontSize: 12,
  fontWeight: 700,
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

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
