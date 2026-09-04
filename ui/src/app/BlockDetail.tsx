//! Baustein-Detail — React-Port von ui/blockdetail.ts. Notes (Melodie) bzw.
//! Steps (Beat/CC/…) editieren. Geöffnet von der Sequencer-Übersicht per
//! langem Druck auf eine Slot-Kachel.

import { useEffect, useState } from "react";
import type { Block, BlockType } from "../state";
import { useNet, useSend, useStoreValue, useRuntimeBlock } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { TRANSPORT_H } from "./layout";
import { BeatEditor, ChordEditor, ArpEditor, ProgramChangeEditor, PatternShiftEditor } from "./blockdetail/editors";
import { MelodyEditor, MelodyToolbar, type MelodyLayout } from "./blockdetail/MelodyEditor";
import type { StepFlow } from "./blockdetail/StepGrid";
import { useLocalPref } from "./useLocalPref";
import { CcEditor } from "./blockdetail/CcEditor";
import { BlockLengthControls } from "./blockdetail/LengthControls";
import { BlockRuntimeStatus, PLAYABLE } from "./blockdetail/RuntimeStatus";

// Stable reference for the useSyncExternalStore selector below — see the
// EMPTY_DEVICES comment in Dashboard.tsx.
const EMPTY_BLOCKS: Block[] = [];

export interface BlockDetailProps {
  blockId: string;
  onClose: () => void;
  onMove: (blockId: string, blockType: BlockType) => void;
}

export function BlockDetail({ blockId, onClose, onMove }: BlockDetailProps) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const block = blocks.find((b) => b.id === blockId);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        top: TRANSPORT_H,
        background: "var(--pal-water-deep)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: 16,
      }}
    >
      {!block ? (
        <>
          {/* Ohne Baustein gibt es keine Kopfzeile, die das Zurück tragen
              könnte — hier steht der Pfeil deshalb für sich. */}
          <Button variant="alt" style={{ width: 56, height: 40, fontSize: 20 }} title="Back" onClick={onClose}>
            ←
          </Button>
          <div style={{ marginTop: 24, color: "var(--pal-text-dim)", fontSize: 18 }}>Block no longer exists.</div>
        </>
      ) : (
        <BlockDetailBody block={block} onClose={onClose} onMove={onMove} openKeyboard={openKeyboard} send={send} />
      )}
    </div>
  );
}

/** „▶ Play" — spielt GENAU diesen Baustein einmal oder in Schleife ab, egal
 *  ob/wo er in einer Lane steckt (s. `Engine::start_block_preview`). Läuft
 *  unabhängig vom Transport, auch bei Stillstand.
 *
 *  Einmal (Loop aus): reiner Fire-and-forget-Tipper — kein eigener „läuft
 *  gerade"-Zustand, ein erneuter Tipp startet einfach neu (die Vorschau löst
 *  sich serverseitig ohnehin selbst ab). Loop an: der Knopf wird zu „■ Stop",
 *  weil eine Schleife sonst nur über den Editor-Umweg wieder aufzuhalten wäre. */
function PlayPreviewButtons({ block, send }: { block: Block; send: ReturnType<typeof useSend> }) {
  const net = useNet();
  const [loop, setLoop] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "control.sendError" && evt.message) {
        setPlaying(false);
        setToast(evt.message);
      }
    });
    return off;
  }, [net]);

  // Baustein gewechselt oder Editor verlassen: eine laufende Schleife nicht
  // im Hintergrund weiterlaufen lassen — die "▶ Play"-Vorschau gehört an den
  // offenen Editor, nicht ans Projekt.
  useEffect(() => {
    return () => {
      if (playing) send({ t: "block.stopPreview" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <>
      <Button
        variant={loop ? "active" : "alt"}
        style={{ width: 70, height: 40, fontSize: 14 }}
        title={playing ? "Stop the running loop before changing this" : "Loop the preview instead of playing it once"}
        disabled={playing}
        onClick={() => setLoop(!loop)}
      >
        ⟲ Loop
      </Button>
      <Button
        variant={playing ? "active" : "default"}
        style={{ width: 90, height: 40, fontSize: 14 }}
        title="Play this block standalone — not tied to any lane"
        onClick={() => {
          if (loop && playing) {
            send({ t: "block.stopPreview" });
            setPlaying(false);
          } else {
            send({ t: "block.play", blockId: block.id, loop });
            setPlaying(loop);
          }
        }}
      >
        {loop && playing ? "■ Stop" : "▶ Play"}
      </Button>
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 480,
            padding: "0 20px",
            height: 56,
            display: "flex",
            alignItems: "center",
            borderRadius: 10,
            background: "rgba(17, 17, 17, 0.97)",
            border: "1.5px solid rgba(255, 255, 255, 0.4)",
            fontSize: 14,
            fontWeight: 600,
            zIndex: 20,
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}

function BlockDetailBody({
  block,
  onClose,
  onMove,
  openKeyboard,
  send,
}: {
  block: Block;
  onClose: () => void;
  onMove: (blockId: string, blockType: BlockType) => void;
  openKeyboard: ReturnType<typeof useTouchKeyboard>;
  send: ReturnType<typeof useSend>;
}) {
  // Wurzel des Editors: hier hängen die Laufzeit-Klassen und -Variablen, die
  // Status-Chip und Step-Playheads weiter unten per CSS erben (runtime.ts).
  const runtimeRef = useRuntimeBlock(block.id);
  // Ansichts-Vorliebe, kein Projekt-Feld: taktweise untereinander oder eine
  // lange Reihe. Bleibt über Screen-Wechsel hinweg stehen (localStorage).
  const [flow, setFlow] = useLocalPref<StepFlow>("blockdetail.stepFlow", "wrap");
  // Wie `flow` eine reine Ansichtssache — sie liegt hier, weil ihr Schalter in
  // der Kopfzeile sitzt (s. MelodyToolbar) und das Raster darunter.
  const [melodyLayout, setMelodyLayout] = useLocalPref<MelodyLayout>("blockdetail.melodyLayout", "stack");
  // „Play in" ist bewusst KEINE gemerkte Vorliebe: der Modus armiert den
  // MIDI-Eingang und blendet die Klaviatur ein — beim nächsten Öffnen eines
  // Bausteins stünde man sonst ungefragt in einem Aufnahme-Modus.
  const [playIn, setPlayIn] = useState(false);

  return (
    <div ref={runtimeRef} className="block-detail" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 16, flexShrink: 0 }}>
        {/* Zurück als reiner Pfeil und IN der Kopfzeile: die eigene Zeile
            darüber kostete auf dem kleinen Display nur Höhe, und "Back" neben
            dem Pfeil sagt nichts, was der Pfeil nicht schon sagt. */}
        <Button variant="alt" style={{ width: 56, height: 40, fontSize: 20 }} title="Back" onClick={onClose}>
          ←
        </Button>
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

        {/* Standalone-Vorschau — für jeden abspielbaren Baustein-Typ, nicht
            nur Melodie, deshalb hier statt in einer typspezifischen Toolbar. */}
        {PLAYABLE.includes(block.type) && <PlayPreviewButtons block={block} send={send} />}

        {/* Grundnote und Spalten/Piano-Roll — die Schalter der Melodie gehören
            in dieselbe Leiste wie Länge und Raster, nicht in eine zweite. */}
        {block.type === "melody" && (
          <MelodyToolbar
            block={block}
            layout={melodyLayout}
            setLayout={setMelodyLayout}
            playIn={playIn}
            setPlayIn={setPlayIn}
          />
        )}

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
            onMove(block.id, block.type as BlockType);
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

      <div style={{ flexShrink: 0 }}>
        <BlockRuntimeStatus block={block} />
      </div>

      {block.type === "melody" && (
        <MelodyEditor block={block} flow={flow} layout={melodyLayout} playIn={playIn && melodyLayout === "grid"} />
      )}
      {block.type === "beat" && <BeatEditor block={block} flow={flow} />}
      {block.type === "chord" && <ChordEditor block={block} flow={flow} />}
      {block.type === "arp" && <ArpEditor block={block} />}
      {block.type === "cc" && <CcEditor block={block} flow={flow} />}
      {block.type === "programChange" && <ProgramChangeEditor block={block} flow={flow} />}
      {block.type === "patternShift" && <PatternShiftEditor block={block} flow={flow} />}
    </div>
  );
}
