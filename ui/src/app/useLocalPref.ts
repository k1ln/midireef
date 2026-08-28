//! Kleine Ansichts-Vorlieben (Layout-Schalter im Baustein-Detail), die den
//! Screen-Wechsel überleben sollen, aber NICHT ins Projekt gehören: sie sagen
//! etwas über den Blick auf einen Baustein, nicht über den Baustein selbst —
//! und ein anderes Gerät am selben Projekt darf getrost anders draufschauen.

import { useCallback, useState } from "react";

export function useLocalPref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback; // Privatmodus/gesperrter Storage — Vorliebe gilt dann nur für diese Sitzung.
    }
  });

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* egal */
      }
    },
    [key],
  );

  return [value, set];
}
