//! Baustein-Raster: Länge in Takten und Auflösung (Substeps pro Takt).
//! Beide Werte sitzen an BlockBase, gelten also für jede Lane, in der der
//! Baustein steckt — deshalb stehen sie im Kopf des Baustein-Details und
//! nicht in einem der typ-spezifischen Editoren (jeder Editor rechnet ohnehin
//! schon `stepsPerBar × lengthBars`).
//!
//! Das Verschieben des Inhalts macht der Server (`block.setLength`): Noten und
//! Trigger behalten beim Auflösungswechsel ihren Zeitpunkt, Step-Arrays werden
//! auf die neue Gesamtlänge gebracht.

import { useState } from "react";
import type { Block } from "../../state";
import { useSend } from "../store";
import { Button } from "../widgets/Button";
import { Popup } from "../widgets/Popup";

/** Takte pro Baustein — der Server klemmt ebenfalls auf 1…16. */
const BAR_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16];

/** Substeps pro Takt. Krumme Werte (6, 12, 24) für Triolen/6-8-Feeling; nach
 *  oben bei 64 Schluss, darüber rundet die Engine die Pulses pro Step nur noch
 *  auf denselben Wert (96 Pulses pro 4/4-Takt). */
const STEPS_PER_BAR_OPTIONS = [4, 6, 8, 12, 16, 24, 32, 48, 64];

export function BlockLengthControls({ block }: { block: Block }) {
  const send = useSend();
  const [picking, setPicking] = useState<"bars" | "steps" | null>(null);
  const bars = block.lengthBars ?? 1;
  const stepsPerBar = block.stepsPerBar ?? 16;

  return (
    <>
      <Button variant="alt" style={{ width: 96, height: 40, fontSize: 15 }} onClick={() => setPicking("bars")}>
        {bars} {bars === 1 ? "bar" : "bars"}
      </Button>
      <Button variant="alt" style={{ width: 120, height: 40, fontSize: 15 }} onClick={() => setPicking("steps")}>
        {stepsPerBar}/bar
      </Button>
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>{bars * stepsPerBar} steps</div>

      {picking === "bars" && (
        <LengthPopup
          title="Length (bars)"
          hint="Content past the new end is dropped."
          options={BAR_OPTIONS}
          current={bars}
          label={(n) => `${n} ${n === 1 ? "bar" : "bars"} — ${n * stepsPerBar} steps`}
          onPick={(n) => send({ t: "block.setLength", blockId: block.id, lengthBars: n })}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === "steps" && (
        <LengthPopup
          title="Substeps per bar"
          hint="Notes keep their timing — the grid gets finer or coarser around them."
          options={STEPS_PER_BAR_OPTIONS}
          current={stepsPerBar}
          label={(n) => `${n} per bar — ${n * bars} steps`}
          onPick={(n) => send({ t: "block.setLength", blockId: block.id, stepsPerBar: n })}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

function LengthPopup({
  title,
  hint,
  options,
  current,
  label,
  onPick,
  onClose,
}: {
  title: string;
  hint: string;
  options: number[];
  current: number;
  label: (n: number) => string;
  onPick: (n: number) => void;
  onClose: () => void;
}) {
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">{title}</div>
      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", margin: "-6px 0 12px" }}>{hint}</div>
      {options.map((n) => (
        <Button
          key={n}
          className="popup-row"
          variant={n === current ? "active" : "default"}
          onClick={() => {
            if (n !== current) onPick(n);
            onClose();
          }}
        >
          {label(n)}
        </Button>
      ))}
    </Popup>
  );
}
