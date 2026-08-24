//! React-Entsprechung zu ui/widgets.ts's pillToggle() — kleiner runder
//! An/Aus-Toggle mit Buchstabe (E/M/S).

export interface PillToggleProps {
  letter: string;
  active: boolean;
  onToggle: () => void;
}

export function PillToggle({ letter, active, onToggle }: PillToggleProps) {
  return (
    <button
      type="button"
      className={`pill-toggle${active ? " on" : ""}`}
      onClick={onToggle}
    >
      {letter}
    </button>
  );
}
