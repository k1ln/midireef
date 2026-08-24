//! CC-Automation: mehrere Layer (LFO/Envelope/Ramp/Random/Stepped), von
//! unten nach oben kombiniert — siehe CcLayer im Modell. Alle Layer-Werte
//! sind 0..1 normiert; die UI zeigt/nimmt 0-127 entgegen und rechnet um.
//! React-Port der ccEditor()/ccLayerRow()/ccLayerDetail()-Methoden aus
//! ui/blockdetail.ts.

import { useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";
import { PillToggle } from "../widgets/PillToggle";
import { StepScroller, StepRuler, StepCell } from "./StepGrid";
import { useNumberEditor, useSetField } from "../useNumberEditor";

const CC_LAYER_KINDS = ["lfo", "envelope", "ramp", "random", "stepped"];
const COMBINE_MODES = ["add", "multiply", "max", "min", "replace"];
const WAVEFORMS = ["sine", "triangle", "sawUp", "sawDown", "square", "randomSmooth"];
const RATE_PRESETS = [0.25, 0.5, 1, 2, 4, 8];

type CcLayer = NonNullable<Block["layers"]>[number];

export function CcEditor({ block }: { block: Block }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const setField = useSetField();
  const [expandedLayerId, setExpandedLayerId] = useState<string | undefined>(undefined);
  const [addingLayer, setAddingLayer] = useState(false);

  const ccNumber = block.ccNumber ?? 74;
  const outMin = block.outMin ?? 0;
  const outMax = block.outMax ?? 127;
  const layers = block.layers ?? [];
  const totalSteps = (block.stepsPerBar ?? 16) * (block.lengthBars ?? 1);
  const expanded = layers.find((l) => l.id === expandedLayerId) ?? layers[0];

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <Button style={{ width: 110, height: 30, fontSize: 14 }} onClick={() => numberEdit(ccNumber, 0, 127, (n) => setField(block.id, "ccNumber", n))}>
          CC {ccNumber}
        </Button>
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
          {expanded && <CcLayerDetail block={block} layer={expanded} totalSteps={totalSteps} />}
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
      <Button
        style={{ width: 90, height: 34, fontSize: 12 }}
        onClick={() => patch({ combine: COMBINE_MODES[(COMBINE_MODES.indexOf(layer.combine) + 1) % COMBINE_MODES.length] })}
      >
        {layer.combine}
      </Button>
      <Button style={{ width: 74, height: 34, fontSize: 13 }} onClick={() => numberEdit(depthPct, 0, 100, (n) => patch({ depth: n / 100 }))}>
        D {depthPct}%
      </Button>
      {/* Offset braucht negative Werte — Stepper statt Texteingabe (Touch-
          Keyboard hat keine Minus-Taste), gleiches Muster wie Device-Transpose. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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

function CcLayerDetail({ block, layer, totalSteps }: { block: Block; layer: CcLayer; totalSteps: number }) {
  const send = useSend();
  const numberEdit = useNumberEditor();
  const patch = (p: object) => send({ t: "cc.updateLayer", blockId: block.id, layerId: layer.id, patch: p });
  const stepsPerBar = block.stepsPerBar ?? 16;

  switch (layer.kind) {
    case "stepped": {
      const values = layer.values ?? new Array(totalSteps).fill(0);
      return (
        <StepScroller>
          <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={34} />
          <div style={{ display: "flex", background: "var(--pal-panel)", opacity: 0.4, height: 100 }}>
            {Array.from({ length: totalSteps }, (_, step) => {
              const v01 = values[step] ?? 0;
              const barH = Math.max(2, v01 * 96);
              return (
                <div
                  key={step}
                  style={{
                    width: 32,
                    height: 100,
                    marginRight: 2,
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    display: "flex",
                    alignItems: "flex-end",
                    cursor: "pointer",
                  }}
                  onClick={() =>
                    numberEdit(Math.round(v01 * 127), 0, 127, (n) =>
                      send({ t: "cc.setStepValue", blockId: block.id, layerId: layer.id, step, value: n / 127 }),
                    )
                  }
                >
                  <div style={{ width: "100%", height: barH, background: "var(--pal-btn-active)" }} />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", marginTop: 2 }}>
            {Array.from({ length: totalSteps }, (_, step) => (
              <div key={step} style={{ width: 34, fontSize: 9, color: "var(--pal-text-dim)" }}>
                {Math.round((values[step] ?? 0) * 127)}
              </div>
            ))}
          </div>
        </StepScroller>
      );
    }
    case "envelope": {
      const points = layer.points ?? [];
      return (
        <div>
          <StepScroller>
            <StepRuler totalSteps={totalSteps} stepsPerBar={stepsPerBar} cellW={46} />
            <div className="step-row">
              {Array.from({ length: totalSteps }, (_, step) => {
                const pt = points.find((p) => p.step === step);
                const disp = Math.round((pt?.value ?? 0) * 127);
                return (
                  <StepCell
                    key={step}
                    width={46}
                    height={40}
                    active={!!pt}
                    onClick={() =>
                      numberEdit(disp, 0, 127, (n) =>
                        send({ t: "cc.setEnvelopePoint", blockId: block.id, layerId: layer.id, step, value: n / 127 }),
                      )
                    }
                    onHoldClear={
                      pt
                        ? () => send({ t: "cc.setEnvelopePoint", blockId: block.id, layerId: layer.id, step, value: null })
                        : undefined
                    }
                  >
                    {pt ? disp : ""}
                  </StepCell>
                );
              })}
            </div>
          </StepScroller>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--pal-text-dim)" }}>
            Tap to set a point, long-press to remove it.
          </div>
        </div>
      );
    }
    case "ramp": {
      const from = Math.round((layer.from ?? 0) * 127);
      const to = Math.round((layer.to ?? 1) * 127);
      return (
        <div style={{ display: "flex", gap: 12 }}>
          <Button style={{ width: 110, height: 36, fontSize: 15 }} onClick={() => numberEdit(from, 0, 127, (n) => patch({ from: n / 127 }))}>
            From {from}
          </Button>
          <Button style={{ width: 110, height: 36, fontSize: 15 }} onClick={() => numberEdit(to, 0, 127, (n) => patch({ to: n / 127 }))}>
            To {to}
          </Button>
        </div>
      );
    }
    case "lfo": {
      const waveform = layer.waveform ?? "sine";
      const rateBars = layer.rateBars ?? 1;
      const phasePct = Math.round((layer.phase ?? 0) * 100);
      return (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button
            style={{ width: 150, height: 36, fontSize: 14 }}
            onClick={() => patch({ waveform: WAVEFORMS[(WAVEFORMS.indexOf(waveform) + 1) % WAVEFORMS.length] })}
          >
            {waveform}
          </Button>
          <Button
            style={{ width: 150, height: 36, fontSize: 13 }}
            onClick={() => {
              const i = RATE_PRESETS.indexOf(rateBars);
              patch({ rateBars: RATE_PRESETS[(i < 0 ? 0 : i + 1) % RATE_PRESETS.length] });
            }}
          >
            {rateBars} bar(s)/cycle
          </Button>
          <Button style={{ width: 130, height: 36, fontSize: 14 }} onClick={() => numberEdit(phasePct, 0, 100, (n) => patch({ phase: n / 100 }))}>
            Phase {phasePct}%
          </Button>
        </div>
      );
    }
    case "random": {
      const everySteps = layer.everySteps ?? 1;
      const smooth = layer.smooth ?? false;
      return (
        <div style={{ display: "flex", gap: 12 }}>
          <Button style={{ width: 160, height: 36, fontSize: 13 }} onClick={() => numberEdit(everySteps, 1, 64, (n) => patch({ everySteps: n }))}>
            Every {everySteps} step(s)
          </Button>
          <Button variant={smooth ? "active" : "default"} style={{ width: 150, height: 36, fontSize: 14 }} onClick={() => patch({ smooth: !smooth })}>
            Smooth: {smooth ? "on" : "off"}
          </Button>
        </div>
      );
    }
    default:
      return null;
  }
}
