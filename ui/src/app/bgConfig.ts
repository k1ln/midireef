//! Hintergrund-Szene: ein Preset + Feinregler, pro Gerät in localStorage
//! (wie uiScale.ts — ein kleiner Touchscreen darf die Szene anders bestücken
//! als ein Monitor). Der Pixi-Hintergrund (background.ts) hört auf
//! BG_CONFIG_EVENT und passt Ticker + Kreaturenzahl live an.
//!
//! Preset "off" ist der Aus-Schalter: der Ticker hält an, das Canvas zeigt nur
//! Schwarz (spart auf schwacher Hardware die komplette Shader-Last). Sobald der
//! Nutzer an einem Regler dreht, springt der Preset auf "custom".

const KEY = "bg.config";
export const BG_CONFIG_EVENT = "bg-config-change";

export type BgPreset = "off" | "calm" | "reef" | "deep" | "custom";

export interface BgConfig {
  preset: BgPreset;
  fish: number;
  squid: number;
  jellyfish: number;
  crabs: number;
  chimneys: number;
  kelp: number;
  /** Notensendungen der Wiedergabe lösen Blasenstöße + Lichtblitze aus. */
  reactNotes: boolean;
  /** Bei laufender Wiedergabe skaliert das Tempo die Strömung/Kreaturen. */
  reactBpm: boolean;
  /** Bild-pro-Sekunde neben der Positionsanzeige einblenden (Transport-Leiste).
   *  Gehört bewusst NICHT zu den Presets: die Anzeige ist ein Messwerkzeug für
   *  genau diese Regler und soll beim Preset-Wechsel stehen bleiben. */
  showFps: boolean;
  /** Obergrenze für den Szene-Ticker (siehe FPS_OPTIONS). Wie `showFps` bewusst
   *  NICHT Teil der Presets — das ist eine reine Performance-Einstellung und
   *  soll beim Preset-Wechsel unangetastet bleiben. */
  fps: number;
}

/** Auswählbare Ticker-Obergrenzen. 30 war bisher fest verdrahtet (background.ts);
 *  niedrigere Werte sparen auf schwacher Hardware (Raspberry Pi) weitere
 *  Shader-Last, kosten aber sichtbar Flüssigkeit der Animation. */
export const FPS_OPTIONS = [10, 15, 24, 30, 45, 60] as const;
export const DEFAULT_FPS = 30;

/** Obergrenzen je Regler. Ein Tipp auf +/– zählt immer 1 hoch/runter;
 *  Gedrückthalten läuft schnell und beschleunigend weiter (s. ProjectSettings).
 *  Grenzen bewusst 10× überzogen ("more is more"). */
export const BG_FIELDS = {
  fish: { max: 140, label: "Fish" },
  squid: { max: 80, label: "Squid" },
  jellyfish: { max: 200, label: "Jellyfish" },
  crabs: { max: 50, label: "Crabs & snails" },
  chimneys: { max: 60, label: "Vents / chimneys" },
  kelp: { max: 480, label: "Kelp" },
} as const;

export type BgCountField = keyof typeof BG_FIELDS;

type PresetBody = Omit<BgConfig, "preset" | "showFps" | "fps">;

const PRESETS: Record<Exclude<BgPreset, "custom">, PresetBody> = {
  off: { fish: 0, squid: 0, jellyfish: 0, crabs: 0, chimneys: 0, kelp: 0, reactNotes: false, reactBpm: false },
  calm: { fish: 3, squid: 0, jellyfish: 6, crabs: 1, chimneys: 0, kelp: 16, reactNotes: false, reactBpm: false },
  reef: { fish: 8, squid: 1, jellyfish: 8, crabs: 2, chimneys: 1, kelp: 32, reactNotes: true, reactBpm: true },
  deep: { fish: 2, squid: 3, jellyfish: 12, crabs: 0, chimneys: 3, kelp: 6, reactNotes: false, reactBpm: true },
};

export const BG_PRESET_NAMES: Exclude<BgPreset, "custom">[] = ["off", "calm", "reef", "deep"];

export const DEFAULT_BG: BgConfig = { preset: "reef", showFps: false, fps: DEFAULT_FPS, ...PRESETS.reef };

/** `showFps`/`fps` werden durchgereicht statt zurückgesetzt — s. Feld-Kommentare. */
export function bgFromPreset(
  preset: Exclude<BgPreset, "custom">,
  showFps = false,
  fps = DEFAULT_FPS,
): BgConfig {
  return { preset, showFps, fps, ...PRESETS[preset] };
}

/** Master-Schalter: jeder Preset außer "off" heißt "Szene läuft". */
export function bgEnabled(cfg: BgConfig): boolean {
  return cfg.preset !== "off";
}

export function getBgConfig(): BgConfig {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_BG;
  } catch {
    return DEFAULT_BG;
  }
}

export function setBgConfig(cfg: BgConfig): BgConfig {
  const clean = sanitize(cfg);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* Privatmodus — gilt dann nur für diese Sitzung. */
  }
  window.dispatchEvent(new Event(BG_CONFIG_EVENT));
  return clean;
}

function clampInt(v: unknown, max: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

function sanitize(p: Partial<BgConfig>): BgConfig {
  const preset: BgPreset =
    p.preset && ["off", "calm", "reef", "deep", "custom"].includes(p.preset) ? p.preset : "custom";
  return {
    preset,
    fish: clampInt(p.fish, BG_FIELDS.fish.max),
    squid: clampInt(p.squid, BG_FIELDS.squid.max),
    jellyfish: clampInt(p.jellyfish, BG_FIELDS.jellyfish.max),
    crabs: clampInt(p.crabs, BG_FIELDS.crabs.max),
    chimneys: clampInt(p.chimneys, BG_FIELDS.chimneys.max),
    kelp: clampInt(p.kelp, BG_FIELDS.kelp.max),
    reactNotes: !!p.reactNotes,
    reactBpm: !!p.reactBpm,
    showFps: !!p.showFps,
    fps: FPS_OPTIONS.includes(p.fps as (typeof FPS_OPTIONS)[number]) ? (p.fps as number) : DEFAULT_FPS,
  };
}
