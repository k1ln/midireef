//! Shared tap-vs-long-press gesture — mirrors the pattern used throughout
//! the old Pixi UI (overview.ts's blockTile, blockdetail.ts's melody step).

import { useRef } from "react";

export function useLongPress(onLongPress: () => void, onTap: () => void, ms = 500) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  return {
    onPointerDown: () => {
      fired.current = false;
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, ms);
    },
    onPointerUp: () => {
      cancel();
      if (!fired.current) onTap();
    },
    onPointerLeave: cancel,
  };
}
