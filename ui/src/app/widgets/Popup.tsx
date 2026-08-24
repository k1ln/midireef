//! React-Entsprechung zu den vielen openXPicker()/showPopupMenu()-Paaren in
//! der alten Pixi-UI: Backdrop (tap = schließen) + zentrierte Box. Native
//! Scroll (`overflow-y: auto` in .modal-box, siehe theme.css) statt der
//! früheren Drag-vs-Tap-Handrolled-Logik in notepicker.ts.

import type { CSSProperties, ReactNode } from "react";

export interface PopupProps {
  onClose: () => void;
  children: ReactNode;
  /** Overrides centering — used by context menus anchored at a tap point. */
  boxStyle?: CSSProperties;
}

export function Popup({ onClose, children, boxStyle }: PopupProps) {
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box" style={boxStyle} onPointerDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
