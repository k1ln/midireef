//! „ST" — Step-Sequencer-Ansicht (Korg-SQ-1-artig, aber mit langen Linien).
//! Links die Liste aller Sequencer (mehrere laufen gleichzeitig), rechts der
//! Editor des gewählten: pro Step ein Pitch-Knob, ein umschaltbarer zweiter
//! Knob (Gate/Velocity/Mod) und ein An/Aus-Pad; Linien über 16 Steps werden in
//! Seiten zu je 16 gezeigt. Alles Timing liegt im Server (`stepseq.rs`) — diese
//! Ansicht schickt nur `stepSeq.*`-Commands und zeigt den Playhead.
//!
//! Der Playhead (`stepSeq.step`) läuft über einen kleinen eigenen Store statt
//! über React-State: pro Step-Wechsel rendert nur die LED neu, die ihren Zustand
//! wirklich ändert, nicht die ganze Ansicht samt 32 Knobs.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Device, SeqTarget, StepSeq } from "../../state";
import type { LiveControl } from "../dashboard/ControlWidget";
import { useNet, useSend, useStoreValue } from "../store";
import { useLocalPref } from "../useLocalPref";
import { useTouchKeyboard } from "../TouchKeyboard";
import { useNotePicker, noteName } from "../NotePicker";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { SelectMenu } from "../widgets/SelectMenu";
import { useWheelPicker } from "../widgets/WheelPicker";
import { TRANSPORT_H } from "../layout";
import { StepKnob } from "./StepKnob";
import { TargetPopup } from "./TargetPopup";

const EMPTY_SEQS: StepSeq[] = [];
const EMPTY_DEVICES: Device[] = [];
const EMPTY_CONTROLS: LiveControl[] = [];

const PAGE = 16;
const RAIL_W = 188;

const RATES = ["1/2", "1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32", "1/32T"];
const DIRECTIONS: { value: string; label: string }[] = [
  { value: "forward", label: "→ Forward" },
  { value: "reverse", label: "← Reverse" },
  { value: "pingPong", label: "↔ Ping-pong" },
  { value: "random", label: "⁇ Random" },
];

/** Playhead je Sequencer, außerhalb von React gehalten (s. Modul-Doku). */
class HeadStore {
  private heads = new Map<string, number | null>();
  private listeners = new Set<() => void>();
  set(id: string, step: number | null) {
    if (this.heads.get(id) === step) return;
    this.heads.set(id, step);
    for (const l of this.listeners) l();
  }
  get(id: string): number | null {
    return this.heads.get(id) ?? null;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

function useIsHead(heads: HeadStore, seqId: string, idx: number): boolean {
  return useSyncExternalStore(heads.subscribe, () => heads.get(seqId) === idx);
}

function Led({ heads, seqId, idx }: { heads: HeadStore; seqId: string; idx: number }) {
  const on = useIsHead(heads, seqId, idx);
  return (
    <div
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: on ? "var(--pal-run)" : "rgba(255,255,255,0.12)",
        boxShadow: on ? "0 0 8px rgba(var(--pal-run-rgb), 0.9)" : "none",
      }}
    />
  );
}

/** Läuft dieser Sequencer gerade wirklich, wartet er nur auf Play, oder steht er? */
function seqState(seq: StepSeq, transportPlaying: boolean): "run" | "wait" | "off" {
  if (!seq.running) return "off";
  return seq.free || transportPlaying ? "run" : "wait";
}

function rateLabel(seq: StepSeq) {
  return `${seq.length} · ${seq.rate} · ${seq.free ? "FREE" : "SYNC"}`;
}

/** Zeigt der Pitch-Knob Notennamen (Notenziele) oder rohe 0–127-Werte (CC/PC)? */
function pitchIsNote(seq: StepSeq, controls: LiveControl[]): boolean {
  if (seq.targets.length === 0) return true;
  return seq.targets.some((t) =>
    t.kind === "device" ? t.mode === "note" : controls.find((c) => c.id === t.controlId)?.mapping?.kind === "note",
  );
}

type Lower = "gate" | "velocity" | "mod";
const LOWER: Record<
  Lower,
  { label: string; min: number; max: number; unit: string; px: number; get: (s: StepSeq["steps"][number]) => number; set: (v: number) => object }
> = {
  gate: { label: "GATE", min: 5, max: 100, unit: "%", px: 1.7, get: (s) => Math.round(s.gate * 100), set: (v) => ({ gate: v / 100 }) },
  velocity: { label: "VEL", min: 1, max: 127, unit: "", px: 1.2, get: (s) => s.velocity, set: (v) => ({ velocity: v }) },
  mod: { label: "MOD", min: 0, max: 127, unit: "", px: 1.2, get: (s) => s.mod, set: (v) => ({ mod: v }) },
};

export function StepSeqView() {
  const send = useSend();
  const net = useNet();
  const seqs = useStoreValue((s) => s.project?.stepSeqs ?? EMPTY_SEQS);
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const [selId, setSelId] = useLocalPref<string>("stepseq.selected", "");
  const [heads] = useState(() => new HeadStore());
  const [transportPlaying, setTransportPlaying] = useState(false);

  const sel = seqs.find((s) => s.id === selId) ?? seqs[0];

  // Playhead + Transportzustand aus dem Event-Strom.
  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "stepSeq.step") heads.set(evt.seqId, evt.step ?? null);
      else if ((evt.t === "transport.tick" || evt.t === "state.snapshot") && evt.transport) {
        setTransportPlaying(!!evt.transport.playing);
      }
    });
    return off;
  }, [net, heads]);

  // Neu angelegten Sequencer gleich auswählen: die ID kennt erst der Server.
  const creating = useRef(false);
  const prevCount = useRef(seqs.length);
  useEffect(() => {
    if (creating.current && seqs.length > prevCount.current) {
      creating.current = false;
      setSelId(seqs[seqs.length - 1].id);
    }
    prevCount.current = seqs.length;
  }, [seqs, setSelId]);

  const create = () => {
    creating.current = true;
    send({ t: "stepSeq.create" });
  };

  return (
    <div style={{ position: "fixed", top: TRANSPORT_H, left: 0, right: 0, bottom: 0, display: "flex", background: "var(--pal-water-deep)" }}>
      <div
        style={{
          width: RAIL_W,
          flexShrink: 0,
          borderRight: "1.5px solid rgba(255,255,255,0.18)",
          overflowY: "auto",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {seqs.map((s) => (
          <SeqCard
            key={s.id}
            seq={s}
            state={seqState(s, transportPlaying)}
            selected={s.id === sel?.id}
            onSelect={() => setSelId(s.id)}
            onToggle={() => send({ t: "stepSeq.setRunning", seqId: s.id, running: !s.running })}
          />
        ))}
        <Button variant="alt" style={{ height: 52, fontSize: 16 }} onClick={create}>
          ＋ Sequencer
        </Button>
      </div>

      {sel ? (
        <Editor
          key={sel.id}
          seq={sel}
          heads={heads}
          devices={devices}
          controls={controls}
          transportPlaying={transportPlaying}
        />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14, color: "var(--pal-text-dim)" }}>
          <div style={{ fontSize: 18 }}>No step sequencer yet.</div>
          <Button style={{ height: 56, padding: "0 28px", fontSize: 18 }} onClick={create}>
            ＋ New sequencer
          </Button>
        </div>
      )}
    </div>
  );
}

function SeqCard({
  seq,
  state,
  selected,
  onSelect,
  onToggle,
}: {
  seq: StepSeq;
  state: "run" | "wait" | "off";
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className="panel"
      onClick={onSelect}
      style={{
        padding: 8,
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        borderColor: selected ? "rgba(255,255,255,0.85)" : undefined,
        background: selected ? "rgba(60,60,60,0.55)" : undefined,
      }}
    >
      <Button
        className={state === "run" ? "transport-stop" : "transport-play"}
        style={{ width: 44, height: 44, fontSize: 18, flexShrink: 0, opacity: state === "wait" ? 0.65 : 1 }}
        title={state === "off" ? "Start" : "Stop"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {state === "off" ? "▶" : state === "wait" ? "…" : "■"}
      </Button>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{seq.name}</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
          {state === "wait" ? "waiting for Play" : rateLabel(seq)}
        </div>
      </div>
    </div>
  );
}

function Editor({
  seq,
  heads,
  devices,
  controls,
  transportPlaying,
}: {
  seq: StepSeq;
  heads: HeadStore;
  devices: Device[];
  controls: LiveControl[];
  transportPlaying: boolean;
}) {
  const send = useSend();
  const wheel = useWheelPicker();
  const keyboard = useTouchKeyboard();
  const notePicker = useNotePicker();
  const [page, setPage] = useState(0);
  const [lower, setLower] = useLocalPref<Lower>("stepseq.lower", "gate");
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [gridW, setGridW] = useState(900);
  const roRef = useRef<ResizeObserver | null>(null);
  const gridRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    setGridW(el.clientWidth);
    roRef.current = new ResizeObserver(() => setGridW(el.clientWidth));
    roRef.current.observe(el);
  }, []);

  const state = seqState(seq, transportPlaying);
  const pages = Math.max(1, Math.ceil(seq.length / PAGE));
  const curPage = Math.min(page, pages - 1);
  const noteMode = pitchIsNote(seq, controls);
  const set = (patch: object) => send({ t: "stepSeq.set", seqId: seq.id, patch });
  const setStep = (step: number, patch: object) => send({ t: "stepSeq.setStep", seqId: seq.id, step, patch });

  const gap = 6;
  const colW = Math.max(40, Math.min(84, Math.floor((gridW - gap * (PAGE - 1)) / PAGE)));
  const knob = Math.max(34, Math.min(60, colW - 6));
  const L = LOWER[lower];

  const targetSummary =
    seq.targets.length === 0
      ? "No target"
      : seq.targets
          .map((t) =>
            t.kind === "device"
              ? devices.find((d) => d.id === t.deviceId)?.name ?? "?"
              : controls.find((c) => c.id === t.controlId)?.name || "button",
          )
          .join(" + ");

  const idxs = Array.from({ length: PAGE }, (_, i) => curPage * PAGE + i);

  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Kopfzeile */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Button
          variant="alt"
          style={{ height: 48, padding: "0 16px", fontSize: 20, fontWeight: 700, maxWidth: 260, overflow: "hidden" }}
          title="Rename"
          onClick={() => keyboard(seq.name, 24, (v) => v && v.trim() && set({ name: v.trim() }))}
        >
          {seq.name}
        </Button>
        <Button
          className={state === "off" ? "transport-play" : "transport-stop"}
          style={{ width: 60, height: 48, fontSize: 20 }}
          onClick={() => send({ t: "stepSeq.setRunning", seqId: seq.id, running: !seq.running })}
        >
          {state === "off" ? "▶" : "■"}
        </Button>
        <Button
          style={{ height: 48, padding: "0 14px", fontWeight: 700 }}
          variant={seq.free ? "active" : "default"}
          title={seq.free ? "Free-running — ignores Play/Stop" : "Follows Play/Stop of the transport"}
          onClick={() => set({ free: !seq.free })}
        >
          {seq.free ? "FREE" : "SYNC"}
        </Button>
        <SelectMenu
          title="Step rate"
          value={seq.rate}
          options={RATES.map((r) => ({ value: r, label: r }))}
          onChange={(v) => set({ rate: v })}
          buttonLabel={`Rate ${seq.rate}`}
          style={{ height: 48, padding: "0 12px" }}
        />
        <SelectMenu
          title="Direction"
          value={seq.direction}
          options={DIRECTIONS}
          onChange={(v) => set({ direction: v })}
          buttonLabel={DIRECTIONS.find((d) => d.value === seq.direction)?.label ?? seq.direction}
          style={{ height: 48, padding: "0 12px" }}
        />
        <Button
          style={{ height: 48, padding: "0 12px" }}
          onClick={() => wheel({ title: "Length (steps)", min: 1, max: 64, value: seq.length, onPick: (v) => set({ length: v }) })}
          title="Longer lines repeat the existing pattern so you can keep building"
        >
          Length {seq.length}
        </Button>
        <Button
          style={{ height: 48, padding: "0 12px" }}
          onClick={() =>
            wheel({
              title: "Swing",
              min: 0,
              max: 100,
              unit: "%",
              value: Math.round(seq.swing * 100),
              onPick: (v) => set({ swing: v / 100 }),
            })
          }
        >
          Swing {Math.round(seq.swing * 100)}%
        </Button>
        {noteMode && (
          <Button
            style={{ height: 48, padding: "0 12px" }}
            onClick={() =>
              wheel({ title: "Transpose (semitones)", min: -24, max: 24, value: seq.transpose, onPick: (v) => set({ transpose: v }) })
            }
          >
            Transp {seq.transpose > 0 ? "+" : ""}
            {seq.transpose}
          </Button>
        )}
        <Button
          variant="alt"
          style={{ height: 48, padding: "0 14px", fontWeight: 700, maxWidth: 320, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
          onClick={() => setTargetsOpen(true)}
          title="Where the steps go"
        >
          → {targetSummary}
        </Button>
        <Button style={{ height: 48, width: 48, fontSize: 20 }} onClick={() => setToolsOpen(true)} title="Pattern tools">
          ⋯
        </Button>
      </div>

      {/* Seiten + Zeilenwahl */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {pages > 1 &&
          Array.from({ length: pages }, (_, p) => (
            <Button
              key={p}
              variant={p === curPage ? "active" : "default"}
              style={{ height: 40, padding: "0 12px", fontSize: 13 }}
              onClick={() => setPage(p)}
            >
              {p * PAGE + 1}–{Math.min(seq.length, (p + 1) * PAGE)}
            </Button>
          ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--pal-text-dim)", fontWeight: 700 }}>LOWER ROW</span>
        {(Object.keys(LOWER) as Lower[]).map((k) => (
          <Button
            key={k}
            variant={k === lower ? "active" : "default"}
            style={{ height: 40, padding: "0 12px", fontSize: 13 }}
            onClick={() => setLower(k)}
          >
            {LOWER[k].label}
          </Button>
        ))}
      </div>

      {/* Step-Raster */}
      <div ref={gridRef} className="panel" style={{ padding: "10px 8px", overflowX: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${PAGE}, minmax(0, 1fr))`, columnGap: gap, rowGap: 8 }}>
          {/* LEDs */}
          {idxs.map((i) => (
            <div key={`l${i}`} style={{ display: "flex", justifyContent: "center", opacity: i < seq.length ? 1 : 0.15 }}>
              <Led heads={heads} seqId={seq.id} idx={i} />
            </div>
          ))}
          {/* Pitch/Value */}
          {idxs.map((i) => {
            const st = seq.steps[i];
            if (i >= seq.length || !st) return <div key={`p${i}`} />;
            return (
              <div key={`p${i}`} style={{ display: "flex", justifyContent: "center" }}>
                <StepKnob
                  value={st.pitch}
                  min={0}
                  max={127}
                  viewMin={24}
                  viewMax={96}
                  pxPerUnit={3.2}
                  size={knob}
                  dim={!st.on}
                  format={(v) => (noteMode ? noteName(v) : String(v))}
                  onChange={(v) => setStep(i, { pitch: v })}
                  onTap={() =>
                    noteMode
                      ? notePicker(st.pitch, (n) => setStep(i, { pitch: n }))
                      : wheel({ title: `Step ${i + 1} value`, min: 0, max: 127, value: st.pitch, onPick: (v) => setStep(i, { pitch: v }) })
                  }
                />
              </div>
            );
          })}
          {/* Zweite Zeile (Gate/Vel/Mod) */}
          {idxs.map((i) => {
            const st = seq.steps[i];
            if (i >= seq.length || !st) return <div key={`g${i}`} />;
            return (
              <div key={`g${i}`} style={{ display: "flex", justifyContent: "center" }}>
                <StepKnob
                  value={L.get(st)}
                  min={L.min}
                  max={L.max}
                  pxPerUnit={L.px}
                  size={knob}
                  dim={!st.on}
                  format={(v) => `${v}${L.unit}`}
                  onChange={(v) => setStep(i, L.set(v))}
                  onTap={() =>
                    wheel({
                      title: `Step ${i + 1} ${L.label.toLowerCase()}`,
                      min: L.min,
                      max: L.max,
                      unit: L.unit,
                      value: L.get(st),
                      onPick: (v) => setStep(i, L.set(v)),
                    })
                  }
                />
              </div>
            );
          })}
          {/* An/Aus-Pads */}
          {idxs.map((i) => {
            const st = seq.steps[i];
            if (i >= seq.length || !st) return <div key={`o${i}`} />;
            return (
              <Button
                key={`o${i}`}
                variant={st.on ? "active" : "default"}
                className="mono"
                style={{
                  height: 46,
                  width: "100%",
                  fontSize: 13,
                  padding: 0,
                  // Gruppierung nach Vierteln: jeder vierte Step etwas abgesetzt.
                  borderLeft: i % 4 === 0 ? "3px solid rgba(255,255,255,0.7)" : undefined,
                }}
                onClick={() => setStep(i, { on: !st.on })}
              >
                {i + 1}
              </Button>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--pal-text-dim)", fontWeight: 700, marginTop: 8, padding: "0 4px" }}>
          <span>{noteMode ? "TOP: PITCH" : "TOP: VALUE"}</span>
          <span>2ND: {L.label}</span>
          <span>BOTTOM: STEP ON/OFF · drag knobs up/down, tap for exact value</span>
        </div>
      </div>

      {targetsOpen && (
        <TargetPopup
          seq={seq}
          devices={devices}
          controls={controls}
          onChange={(targets: SeqTarget[]) => send({ t: "stepSeq.setTargets", seqId: seq.id, targets })}
          onClose={() => setTargetsOpen(false)}
        />
      )}
      {toolsOpen && <ToolsPopup seq={seq} noteMode={noteMode} onClose={() => setToolsOpen(false)} />}
    </div>
  );
}

function ToolsPopup({ seq, noteMode, onClose }: { seq: StepSeq; noteMode: boolean; onClose: () => void }) {
  const send = useSend();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rnd = (what: string) =>
    send({ t: "stepSeq.randomize", seqId: seq.id, what, ...(what === "pitch" ? (noteMode ? { min: 48, max: 72 } : { min: 0, max: 127 }) : {}) });
  return (
    <Popup onClose={onClose} boxStyle={{ width: 380 }}>
      <div className="popup-title">Pattern · {seq.name}</div>
      <Button className="popup-row" onClick={() => rnd("pitch")}>
        🎲 Randomize {noteMode ? "pitch (C3–C5)" : "values"}
      </Button>
      <Button className="popup-row" onClick={() => rnd("gate")}>
        🎲 Randomize gate
      </Button>
      <Button className="popup-row" onClick={() => rnd("velocity")}>
        🎲 Randomize velocity
      </Button>
      <Button className="popup-row" onClick={() => rnd("on")}>
        🎲 Randomize steps on/off
      </Button>
      <div style={{ display: "flex", gap: 8 }}>
        <Button className="popup-row" style={{ flex: 1, width: "auto", minWidth: 0 }} onClick={() => send({ t: "stepSeq.shift", seqId: seq.id, by: -1 })}>
          ◀ Shift
        </Button>
        <Button className="popup-row" style={{ flex: 1, width: "auto", minWidth: 0 }} onClick={() => send({ t: "stepSeq.shift", seqId: seq.id, by: 1 })}>
          Shift ▶
        </Button>
      </div>
      <Button className="popup-row" onClick={() => send({ t: "stepSeq.clear", seqId: seq.id })}>
        Reset all steps
      </Button>
      <Button
        className="popup-row"
        onClick={() => {
          send({ t: "stepSeq.duplicate", seqId: seq.id });
          onClose();
        }}
      >
        Duplicate sequencer
      </Button>
      <Button
        className="popup-row"
        variant={confirmDelete ? "danger" : "default"}
        onClick={() => {
          if (!confirmDelete) return setConfirmDelete(true);
          send({ t: "stepSeq.delete", seqId: seq.id });
          onClose();
        }}
      >
        {confirmDelete ? "Tap again to delete" : "Delete sequencer"}
      </Button>
      <Button className="popup-row" variant="alt" onClick={onClose}>
        Done
      </Button>
    </Popup>
  );
}
