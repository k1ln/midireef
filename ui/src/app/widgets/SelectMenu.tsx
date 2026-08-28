//! Dropdown-Auswahl statt Klick-zum-Weiterschalten: zeigt den aktuellen Wert
//! als Button und öffnet bei Antippen ein zentriertes Popup mit ALLEN Optionen
//! (die laufende ist hervorgehoben). So trifft man auf dem Touchdisplay gezielt
//! einen Wert, statt sich durch einen Zyklus zu tippen.

import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import { Popup } from "./Popup";

export interface SelectOption<T> {
  value: T;
  label: ReactNode;
}

export interface SelectMenuProps<T> {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  /** Popup-Überschrift und (falls kein `buttonLabel`) Fallback-Titel. */
  title?: string;
  /** Beschriftung des geschlossenen Buttons; ohne sie das Label der aktiven Option. */
  buttonLabel?: ReactNode;
  variant?: ButtonProps["variant"];
  className?: string;
  style?: CSSProperties;
  buttonTitle?: string;
  disabled?: boolean;
}

export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  title,
  buttonLabel,
  variant,
  className,
  style,
  buttonTitle,
  disabled,
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Button
        variant={variant}
        className={className}
        style={style}
        title={buttonTitle}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {buttonLabel ?? current?.label ?? String(value)}
      </Button>
      {open && (
        <Popup onClose={() => setOpen(false)}>
          {title && <div className="popup-title">{title}</div>}
          {options.map((o) => (
            <Button
              key={String(o.value)}
              className="popup-row"
              variant={o.value === value ? "active" : "default"}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </Button>
          ))}
        </Popup>
      )}
    </>
  );
}
