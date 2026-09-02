//! React-Entsprechung zu ui/widgets.ts's pillToggle() — kleiner runder
//! An/Aus-Toggle mit Buchstabe (E/M/S).

export interface PillToggleProps {
  letter: string;
  active: boolean;
  onToggle: () => void;
  /** Override the 40×40 default — e.g. the compact lane-rail grid. */
  style?: React.CSSProperties;
}

export function PillToggle({ letter, active, onToggle, style }: PillToggleProps) {
  return (
    <button
      type="button"
      className={`pill-toggle${active ? " on" : ""}`}
      style={style}
      onClick={onToggle}
    >
      {letter}
    </button>
  );
}
