//! Kleine Ansichts-Vorlieben (Layout-Schalter im Baustein-Detail, Lane-Lock),
//! die den Screen-Wechsel überleben sollen, aber NICHT ins Projekt gehören: sie
//! sagen etwas über den Blick auf einen Baustein, nicht über den Baustein
//! selbst — und ein anderes Gerät am selben Projekt darf getrost anders
//! draufschauen.

import { useCallback, useEffect, useState } from "react";

// Alle Hook-Instanzen zum selben Key teilen sich den Wert: ändert ihn eine
// Komponente (z.B. der Lock-Schalter im Lane-Menü), ziehen die anderen (die
// Lane-Zeile und ihre Kacheln) sofort nach. Ohne das rendert die andere Seite
// erst beim nächsten unabhängigen Update neu — der Lock-Umschalter „wirkte"
// dann scheinbar nicht.
const listeners = new Map<string, Set<(v: string) => void>>();

export function useLocalPref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback; // Privatmodus/gesperrter Storage — Vorliebe gilt dann nur für diese Sitzung.
    }
  });

  useEffect(() => {
    const notify = (v: string) => setValue(v as T);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(notify);
    // Beim (Wieder-)Einhängen den aktuellen Storage-Wert übernehmen — eine
    // andere Instanz kann ihn geändert haben, während dieser Hook aus war.
    try {
      const cur = window.localStorage.getItem(key);
      if (cur != null) setValue(cur as T);
    } catch {
      /* egal */
    }
    return () => {
      set!.delete(notify);
      if (set!.size === 0) listeners.delete(key);
    };
  }, [key]);

  const set = useCallback(
    (v: T) => {
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* egal */
      }
      // Alle Instanzen (diese eingeschlossen) auf den neuen Wert ziehen.
      listeners.get(key)?.forEach((fn) => fn(v));
    },
    [key],
  );

  return [value, set];
}
