//! Tap → Touch-Keyboard für Ganzzahl-Eingabe, geklemmt auf [min, max].
//! Shared across the Block Detail editors (mirrors editNumber() in the old
//! ui/blockdetail.ts).

import { useTouchKeyboard } from "./TouchKeyboard";
import { useSend } from "./store";

export function useSetField() {
  const send = useSend();
  return (blockId: string, field: string, value: unknown) => send({ t: "block.setField", blockId, field, value });
}

export function useNumberEditor() {
  const openKeyboard = useTouchKeyboard();
  return (current: number, min: number, max: number, onSet: (n: number) => void, maxLen = 4) => {
    openKeyboard(String(current), maxLen, (v) => {
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) onSet(Math.min(max, Math.max(min, n)));
    });
  };
}
