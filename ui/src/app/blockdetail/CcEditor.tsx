//! CC-Automation: mehrere Layer (LFO/Envelope/Ramp/Random/Stepped), von
//! unten nach oben kombiniert — siehe CcLayer im Modell. Alle Layer-Werte
//! sind 0..1 normiert; die UI zeigt/nimmt 0-127 entgegen und rechnet um.
//! React-Port der ccEditor()/ccLayerRow()/ccLayerDetail()-Methoden aus
//! ui/blockdetail.ts.
//!
//! Der Baustein beschreibt hier NUR die Bewegung. Auf welchen CC sie geht,
//! wählt die Lane in der Sequencer-Übersicht (ihr Ziel-Knob) — derselbe
//! Baustein läuft so in mehreren Lanes auf unterschiedlichen CCs.

import { useEffect, useRef, useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { PillToggle } from "../widgets/PillToggle";
import { StepBars, type StepFlow } from "./StepGrid";
import { useNumberEditor, useSetField } from "../useNumberEditor";

const CC_LAYER_KINDS = ["lfo", "envelope", "ramp", "random", "stepped"];
const COMBINE_MODES = ["add", "multiply", "max", "min", "replace"];
const WAVEFORMS = ["sine", "triangle", "sawUp", "sawDown", "square", "randomSmooth"];
const RATE_PRESETS = [0.25, 0.5, 1, 2, 4, 8];
// LFO-Rate folgt der auslösenden Note: 0 = aus, 1 = ×2 pro Oktave (s. engine.rs).
const KEY_TRACK_PRESETS = [0, 0.5, 1, 2];

// Value-bar boxes (stepped/envelope layers) — big enough for a finger, and
// the value is set directly from where you tap/drag inside the box (no
// touch-keyboard round-trip): top of the box = 127, bottom = 0.
const VALUE_BOX_W = 48;
const VALUE_BOX_H = 168;

/** `touch-action: pan-x` teilt die Geste zwischen Editor und Scroller auf:
 *  senkrecht ziehen setzt den Wert, waagerecht wischen scrollt das Raster.
 *  Vorher stand hier `none` — damit war ein langes Raster auf dem Touchdisplay
 *  überhaupt nicht mehr zu bewegen, weil jede Berührung im Raster als Zeichnen
 *  galt. */
const VALUE_BOX_STYLE: React.CSSProperties = {
  width: VALUE_BOX_W,
  flexShrink: 0,
  height: VALUE_BOX_H,
  marginRight: 2,
  border: "1px solid var(--pal-step-border)",
  display: "flex",
  alignItems: "flex-end",
  cursor: "pointer",
  touchAction: "pan-x",
};

/** 0..127, read straight off the pointer's vertical position inside the box
 *  the listener is attached to (top = 127, bottom = 0). */
function valueFromPointer(e: React.PointerEvent<HTMLDivElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = 1 - (e.clientY - rect.top) / rect.height;
  return Math.round(Math.min(1, Math.max(0, frac)) * 127);
}

type CcLayer = NonNullable<Block["layers"]>[number];

export function CcEditor({ block, flow }: { block: Block; flow: StepFlow }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const setField = useSetField();
  const [expandedLayerId, setExpandedLayerId] = useState<string | undefined>(undefined);
  const [addingLayer, setAddingLayer] = useState(false);
  // Der Server vergibt die Layer-Id, die UI kennt sie also erst mit dem
  // nächsten Snapshot — dieses Flag merkt sich "gleich den neuesten aufklappen".
  // Ohne das blieb nach "＋ Layer" der ALTE Layer offen und der neue LFO stand
  // ohne sichtbare Rate/Waveform da (die Detail-Parameter hängen am aufgeklappten
  // Layer, nicht an der Zeile).
  const [expandNewest, setExpandNewest] = useState(false);

  const outMin = block.outMin ?? 0;
  const outMax = block.outMax ?? 127;
  const layers = block.layers ?? [];
  const totalSteps = (block.stepsPerBar ?? 16) * (block.lengthBars ?? 1);
  const expanded = layers.find((l) => l.id === expandedLayerId) ?? layers[0];

  const newestLayerId = layers[layers.length - 1]?.id;
  useEffect(() => {
    if (expandNewest && newestLayerId) {
      setExpandedLayerId(newestLayerId);
      setExpandNewest(false);
    }
  }, [expandNewest, newestLayerId]);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <Button style={{ width: 100, height: 30, fontSize: 14 }} onClick={() => numberEdit(outMin, 0, 127, (n) => setField(block.id, "outMin", n))}>
          Min {outMin}
        </Button>
        <Button style={{ width: 100, height: 30, fontSize: 14 }} onClick={() => numberEdit(outMax, 0, 127, (n) => setField(block.id, "outMax", n))}>
          Max {outMax}
        </Button>
        <Button variant="alt" style={{ width: 100, height: 30, fontSize: 14 }} onClick={() => setAddingLayer(true)}>
          ＋ Layer
        </Button>
      </div>

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Movement only — which CC this drives is set on the lane in the Sequencer overview.
      </div>

      {layers.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No layers yet — tap “＋ Layer” to add one.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {layers.map((layer, i) => (
              <CcLayerRow
                key={layer.id}
                block={block}
                layer={layer}
                index={i}
                total={layers.length}
                expanded={(expandedLayerId ?? layers[0]?.id) === layer.id}
                onExpand={() => setExpandedLayerId(layer.id)}
                onDeselect={() => {
                  if (expandedLayerId === layer.id) setExpandedLayerId(undefined);
                }}
              />
            ))}
          </div>
          {expanded && <CcLayerDetail block={block} layer={expanded} totalSteps={totalSteps} flow={flow} />}
        </>
      )}

      {addingLayer && (
        <Popup onClose={() => setAddingLayer(false)}>
          <div className="popup-title">Add layer</div>
          {CC_LAYER_KINDS.map((kind) => (
            <Button
              key={kind}
              className="popup-row"
              onClick={() => {
                setAddingLayer(false);
                setExpandNewest(true);
                send({ t: "cc.addLayer", blockId: block.id, kind, steps: totalSteps || 16 });
              }}
            >
              {kind}
            </Button>
          ))}
        </Popup>
      )}
    </div>
  );
}

function CcLayerRow({
  block,
  layer,
  index,
  total,
  expanded,
  onExpand,
  onDeselect,
}: {
  block: Block;
  layer: CcLayer;
  index: number;
  total: number;
  expanded: boolean;
  onExpand: () => void;
  onDeselect: () => void;
}) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const patch = (p: object) => send({ t: "cc.updateLayer", blockId: block.id, layerId: layer.id, patch: p });

  const depthPct = Math.round((layer.depth ?? 1) * 100);
  const offsetPct = Math.round((layer.offset ?? 0) * 100);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <PillToggle letter="●" active={layer.enabled} onToggle={() => patch({ enabled: !layer.enabled })} />
      <Button variant={expanded ? "active" : "default"} style={{ width: 92, height: 34, fontSize: 13 }} onClick={onExpand}>
        {layer.kind}
      </Button>
      {/* Der unterste Layer ist die Basis — sein Combine-Modus wird von der
          Engine ignoriert (mit "multiply"/"min" gegen einen Start-Akku von 0
          käme sonst garantiert Stille heraus). Deshalb hier kein Button,
          sondern eine Beschriftung. */}
      {index === 0 ? (
        <div
          style={{ width: 90, fontSize: 12, fontWeight: 600, textAlign: "center", color: "var(--pal-text-dim)" }}
          title="Bottom layer is the base — it sets the starting value the layers above combine with"
        >
          base
        </div>
      ) : (
        <Button
          style={{ width: 90, height: 34, fontSize: 12 }}
          onClick={() => patch({ combine: COMBINE_MODES[(COMBINE_MODES.indexOf(layer.combine) + 1) % COMBINE_MODES.length] })}
        >
          {layer.combine}
        </Button>
      )}
      <Button
        style={{ width: 88, height: 34, fontSize: 13 }}
        title="Depth — scales the movement (contribution = movement × depth + offset)"
        onClick={() => numberEdit(depthPct, 0, 100, (n) => patch({ depth: n / 100 }))}
      >
        Depth {depthPct}%
      </Button>
      {/* Offset braucht negative Werte — Stepper statt Texteingabe (Touch-
          Keyboard hat keine Minus-Taste), gleiches Muster wie der Slot-Transpose. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="Offset — shifts the scaled movement up/down">
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pal-text-dim)" }}>Off</span>
        <Button style={{ width: 24, height: 34, fontSize: 16 }} onClick={() => patch({ offset: Math.max(-1, (layer.offset ?? 0) - 0.05) })}>
          –
        </Button>
        <span style={{ fontSize: 11, color: "var(--pal-text-dim)", fontWeight: 600, minWidth: 36, textAlign: "center" }}>
          {offsetPct}%
        </span>
        <Button style={{ width: 24, height: 34, fontSize: 16 }} onClick={() => patch({ offset: Math.min(1, (layer.offset ?? 0) + 0.05) })}>
          +
        </Button>
      </div>
      {index > 0 && (
        <Button
          style={{ width: 26, height: 34, fontSize: 11 }}
          onClick={() => send({ t: "cc.moveLayer", blockId: block.id, layerId: layer.id, dir: "up" })}
        >
          ▲
        </Button>
      )}
      {index < total - 1 && (
        <Button
          style={{ width: 26, height: 34, fontSize: 11 }}
          onClick={() => send({ t: "cc.moveLayer", blockId: block.id, layerId: layer.id, dir: "down" })}
        >
          ▼
        </Button>
      )}
      <Button
        variant="danger"
        style={{ width: 26, height: 34, fontSize: 13 }}
        onClick={() => {
          onDeselect();
          send({ t: "cc.removeLayer", blockId: block.id, layerId: layer.id });
        }}
      >
        ✕
      </Button>
    </div>
  );
}

/** Beschriftetes Parameterfeld — die Layer-Detail-Panels waren vorher Reihen
 *  anonymer Buttons ("sine", "1 bar(s)/cycle"), bei denen man raten musste,
 *  welcher davon die Rate ist. */
function Param({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: "var(--pal-text-dim)" }}>
        {label.toUpperCase()}
      </span>
      {children}
    </div>
  );
}

function ParamRow({ hint, children }: { hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>{children}</div>
      {hint && <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>{hint}</div>}
    </div>
  );
}

function CcLayerDetail({ block, layer, totalSteps, flow }: { block: Block; layer: CcLayer; totalSteps: number; flow: StepFlow }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const holdTimer = useRef<number | undefined>(undefined);
  // Gesten-Weiche der Wertekästen. Beim Aufsetzen wird noch NICHTS geschrieben,
  // erst die Richtung entscheidet:
  //   senkrecht ziehen → Wert malen ("draw")
  //   waagerecht wischen → Raster scrollen ("pan"), kein Wert
  //   nur tippen → Wert beim Loslassen setzen
  // Ohne diese Weiche verbog jedes Scrollen die Werte, über die der Finger lief
  // (die Kästen sind fingerbreit — beim Wischen berührt man zwangsläufig einen).
  const gesture = useRef<{ x: number; y: number; mode: "idle" | "draw" | "pan" }>({ x: 0, y: 0, mode: "idle" });
  const DIR_SLOP = 6; // px, ab hier gilt die Richtung als erkannt

  /** Liefert true, solange die Geste als Werte-Malen gilt. */
  const dragMode = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const g = gesture.current;
    if (g.mode !== "idle") return g.mode === "draw";
    const dx = Math.abs(e.clientX - g.x);
    const dy = Math.abs(e.clientY - g.y);
    if (Math.max(dx, dy) < DIR_SLOP) return false; // noch unentschieden
    g.mode = dy >= dx ? "draw" : "pan";
    return g.mode === "draw";
  };
  const patch = (p: object) => send({ t: "cc.updateLayer", blockId: block.id, layerId: layer.id, patch: p });
  const stepsPerBar = block.stepsPerBar ?? 16;

  switch (layer.kind) {
    case "stepped": {
      const values = layer.values ?? new Array(totalSteps).fill(0);
      const setStep = (step: number, e: React.PointerEvent<HTMLDivElement>) =>
        send({ t: "cc.setStepValue", blockId: block.id, layerId: layer.id, step, value: valueFromPointer(e) / 127 });
      return (
        <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={VALUE_BOX_W + 2} flow={flow}>
          {(steps) => (
            <>
              <div style={{ display: "flex", background: "var(--pal-step-off)", height: VALUE_BOX_H }}>
                {steps.map((step) => {
                  const v01 = values[step] ?? 0;
                  const barH = Math.max(3, v01 * (VALUE_BOX_H - 4));
                  return (
                    <div
                      key={step}
                      style={{ ...VALUE_BOX_STYLE }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        gesture.current = { x: e.clientX, y: e.clientY, mode: "idle" };
                      }}
                      onPointerMove={(e) => {
                        if (e.buttons === 1 && dragMode(e)) setStep(step, e);
                      }}
                      onPointerUp={(e) => {
                        if (gesture.current.mode === "idle") setStep(step, e); // Tipper
                        gesture.current.mode = "pan";
                      }}
                      onPointerCancel={() => {
                        gesture.current.mode = "pan";
                      }}
                    >
                      <div style={{ width: "100%", height: barH, background: "var(--pal-btn-active)" }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", marginTop: 2 }}>
                {steps.map((step) => (
                  <div key={step} style={{ width: VALUE_BOX_W + 2, flexShrink: 0, fontSize: 9, color: "var(--pal-text-dim)" }}>
                    {Math.round((values[step] ?? 0) * 127)}
                  </div>
                ))}
              </div>
            </>
          )}
        </StepBars>
      );
    }
    case "envelope": {
      const points = layer.points ?? [];
      const setPoint = (step: number, e: React.PointerEvent<HTMLDivElement>) =>
        send({ t: "cc.setEnvelopePoint", blockId: block.id, layerId: layer.id, step, value: valueFromPointer(e) / 127 });
      const clearPoint = (step: number) =>
        send({ t: "cc.setEnvelopePoint", blockId: block.id, layerId: layer.id, step, value: null });
      return (
        <div>
          <StepBars totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={VALUE_BOX_W + 2} flow={flow}>
            {(steps) => (
              <>
                <div style={{ display: "flex", background: "var(--pal-step-off)", height: VALUE_BOX_H }}>
                  {steps.map((step) => {
                    const pt = points.find((p) => p.step === step);
                    const v01 = pt?.value ?? 0;
                    const barH = Math.max(3, v01 * (VALUE_BOX_H - 4));
                    return (
                      <div
                        key={step}
                        style={{ ...VALUE_BOX_STYLE }}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture(e.pointerId);
                          gesture.current = { x: e.clientX, y: e.clientY, mode: "idle" };
                          // Löst das lange Drücken aus, ist der Punkt weg —
                          // dann darf das folgende pointerup ihn nicht sofort
                          // wieder setzen (mode "pan" heißt: nichts mehr tun).
                          if (pt)
                            holdTimer.current = window.setTimeout(() => {
                              clearPoint(step);
                              gesture.current.mode = "pan";
                            }, 500);
                        }}
                        onPointerMove={(e) => {
                          if (e.buttons === 1 && dragMode(e)) {
                            window.clearTimeout(holdTimer.current);
                            setPoint(step, e);
                          }
                        }}
                        onPointerUp={(e) => {
                          window.clearTimeout(holdTimer.current);
                          if (gesture.current.mode === "idle") setPoint(step, e); // Tipper
                          gesture.current.mode = "pan";
                        }}
                        onPointerCancel={() => {
                          window.clearTimeout(holdTimer.current);
                          gesture.current.mode = "pan";
                        }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: barH,
                            background: pt ? "var(--pal-btn-active)" : "transparent",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", marginTop: 2 }}>
                  {steps.map((step) => {
                    const pt = points.find((p) => p.step === step);
                    return (
                      <div key={step} style={{ width: VALUE_BOX_W + 2, flexShrink: 0, fontSize: 9, color: "var(--pal-text-dim)" }}>
                        {pt ? Math.round(pt.value * 127) : ""}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </StepBars>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
            Drag up/down inside a box to set its point, long-press an existing point to remove it. Swipe sideways to scroll.
          </div>
        </div>
      );
    }
    case "ramp": {
      const from = Math.round((layer.from ?? 0) * 127);
      const to = Math.round((layer.to ?? 1) * 127);
      return (
        <ParamRow hint="A straight sweep across the block — from the first step to the last.">
          <Param label="From">
            <Button style={{ width: 110, height: 36, fontSize: 15 }} onClick={() => numberEdit(from, 0, 127, (n) => patch({ from: n / 127 }))}>
              {from}
            </Button>
          </Param>
          <Param label="To">
            <Button style={{ width: 110, height: 36, fontSize: 15 }} onClick={() => numberEdit(to, 0, 127, (n) => patch({ to: n / 127 }))}>
              {to}
            </Button>
          </Param>
        </ParamRow>
      );
    }
    case "lfo": {
      const waveform = layer.waveform ?? "sine";
      const rateMode = layer.rateMode ?? "bars";
      const rateBars = layer.rateBars ?? 1;
      // Hz range covers "normal" (sub-1Hz, musical) through "high" (near audio-rate) —
      // capped at 25Hz since the engine's send-rate limiter (~50 msg/s) can't usefully
      // resolve much faster than that anyway (see engine.rs MIN_CC_SEND_INTERVAL).
      const rateHz = layer.rateHz ?? 1;
      const phasePct = Math.round((layer.phase ?? 0) * 100);
      const keyTrack = layer.rateKeyTrack ?? 0;
      return (
        <ParamRow
          hint={
            rateMode === "hz"
              ? "Free-running: the rate stays put when the tempo changes."
              : "Tempo-synced: one full cycle per this many bars, so it follows the BPM."
          }
        >
          <Param label="Wave">
            <Button
              style={{ width: 150, height: 36, fontSize: 14 }}
              onClick={() => patch({ waveform: WAVEFORMS[(WAVEFORMS.indexOf(waveform) + 1) % WAVEFORMS.length] })}
            >
              {waveform}
            </Button>
          </Param>
          <Param label="Rate mode">
            <Button
              variant={rateMode === "hz" ? "active" : "default"}
              style={{ width: 110, height: 36, fontSize: 13 }}
              onClick={() => patch({ rateMode: rateMode === "hz" ? "bars" : "hz" })}
            >
              {rateMode === "hz" ? "Hz (free)" : "Bars (sync)"}
            </Button>
          </Param>
          <Param label="Rate">
            {rateMode === "hz" ? (
              <Button
                style={{ width: 150, height: 36, fontSize: 13 }}
                onClick={() => numberEdit(Math.round(rateHz * 100), 5, 2500, (n) => patch({ rateHz: n / 100 }), 4)}
              >
                {rateHz.toFixed(2)} Hz
              </Button>
            ) : (
              <Button
                style={{ width: 150, height: 36, fontSize: 13 }}
                onClick={() => {
                  const i = RATE_PRESETS.indexOf(rateBars);
                  patch({ rateBars: RATE_PRESETS[(i < 0 ? 0 : i + 1) % RATE_PRESETS.length] });
                }}
              >
                {rateBars} bar(s)/cycle
              </Button>
            )}
          </Param>
          <Param label="Phase">
            <Button style={{ width: 110, height: 36, fontSize: 14 }} onClick={() => numberEdit(phasePct, 0, 100, (n) => patch({ phase: n / 100 }))}>
              {phasePct}%
            </Button>
          </Param>
          <Param label="Key-track">
            <Button
              variant={keyTrack !== 0 ? "active" : "default"}
              style={{ width: 130, height: 36, fontSize: 13 }}
              title="LFO rate follows the note that triggered the lane — higher note, faster wobble"
              onClick={() => {
                const i = KEY_TRACK_PRESETS.indexOf(keyTrack);
                patch({ rateKeyTrack: KEY_TRACK_PRESETS[(i < 0 ? 0 : i + 1) % KEY_TRACK_PRESETS.length] });
              }}
            >
              {keyTrack === 0 ? "off" : `×${keyTrack}/oct`}
            </Button>
          </Param>
        </ParamRow>
      );
    }
    case "random": {
      const everySteps = layer.everySteps ?? 1;
      const smooth = layer.smooth ?? false;
      return (
        <ParamRow hint="New value every n steps, counted from transport start — so it keeps changing instead of repeating each loop.">
          <Param label="New value every">
            <Button style={{ width: 160, height: 36, fontSize: 13 }} onClick={() => numberEdit(everySteps, 1, 64, (n) => patch({ everySteps: n }))}>
              {everySteps} step(s)
            </Button>
          </Param>
          <Param label="Smooth">
            <Button variant={smooth ? "active" : "default"} style={{ width: 110, height: 36, fontSize: 14 }} onClick={() => patch({ smooth: !smooth })}>
              {smooth ? "on (glide)" : "off (jump)"}
            </Button>
          </Param>
        </ParamRow>
      );
    }
    default:
      return null;
  }
}
