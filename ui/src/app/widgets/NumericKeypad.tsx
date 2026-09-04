//! Ziffernblock-Gitter, geteilt zwischen WheelPicker (ersetzt dort die Rad-
//! Ansicht während des Tippens) und Knob (eigenes Vollbild-Popup) — dieselbe
//! Eingabe für „ich weiß den genauen Wert, kein Herumziehen nötig".

import { useState } from "react";
import { Button } from "./Button";

export function useKeypadText(initial: number) {
  const [text, setText] = useState(String(initial));
  const appendDigit = (d: string) => setText((t) => (t === "0" ? d : t + d));
  const backspace = () => setText((t) => t.slice(0, -1));
  const toggleSign = () => setText((t) => (t.startsWith("-") ? t.slice(1) : t.length ? `-${t}` : t));
  return { text, reset: setText, appendDigit, backspace, toggleSign };
}

export function NumericKeypadGrid({
  text,
  unit,
  allowNegative,
  onDigit,
  onBackspace,
  onToggleSign,
  onCancel,
  onCommit,
}: {
  text: string;
  unit?: string;
  allowNegative: boolean;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onToggleSign: () => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="wheel-keypad">
      <div className="wheel-keypad-display">
        {text || "0"}
        {unit ?? ""}
      </div>
      {[
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
      ].map((row) => (
        <div key={row.join("")} className="kb-row">
          {row.map((k) => (
            <Button key={k} className="kb-key" onClick={() => onDigit(k)}>
              {k}
            </Button>
          ))}
        </div>
      ))}
      <div className="kb-row">
        {allowNegative ? (
          <Button className="kb-key" onClick={onToggleSign}>
            ±
          </Button>
        ) : (
          <span className="kb-key" />
        )}
        <Button className="kb-key" onClick={() => onDigit("0")}>
          0
        </Button>
        <Button className="kb-key" onClick={onBackspace}>
          ⌫
        </Button>
      </div>
      <div className="kb-row">
        <Button variant="danger" style={{ flex: "1 1 0", height: 52 }} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="active" style={{ flex: "1 1 0", height: 52 }} onClick={onCommit}>
          OK
        </Button>
      </div>
    </div>
  );
}
