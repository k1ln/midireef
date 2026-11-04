//! TD-3-Melodie: Acid-Pattern für den Behringer TD-3 (MO) würfeln ODER von
//! Hand eintippen, probehören und als Melodie-Baustein behalten.
//!
//! Der TD-3 kennt pro Step Note/Pause, ACCENT und SLIDE — über MIDI sind das
//! hoher Anschlag bzw. eine über den nächsten Step hinaus gehaltene Note. Der
//! Server (`td3.rs`) erzeugt das Pattern und baut die Noten; dieser Dialog
//! stellt die Regler, zeigt das Ergebnis wie das TD-3-Display (Ton, A, Slide)
//! und bietet zwei Wege zum Pattern:
//!
//!   "Generate" — Tonart, Skala, Dichte … einstellen, 🎲 würfelt neu. Gleiche
//!     Einstellung + gleicher Seed = gleiches Pattern.
//!   "Input"    — Step antippen, Ton auf der Klaviatur tippen, der Cursor
//!     springt zum nächsten Step: so tippt man eine Melodie in Sekunden ein.
//!     Je Step: Pause, Accent, Glide, Länge, Tonhöhe ±.
//!
//! Das Pattern lebt hier im Dialog (`pattern`) — nach Handbearbeitung schickt
//! der Dialog es dem Server als `pattern`, statt neu würfeln zu lassen. Wer
//! danach einen Generator-Regler dreht, würfelt wieder neu (die Handarbeit
//! weicht; ein Hinweis zeigt, wann das so ist).
//!
//! Lebenszyklus wie beim MIDI-Import: das Pattern liegt als echter Entwurfs-
//! Baustein in der Bibliothek (Vorschau = normale Baustein-Vorschau), jede
//! Änderung zieht ihn nach, "Close" löscht ihn, "Add" lässt ihn stehen.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNet, useSend } from "./store";
import { noteName } from "./NotePicker";
import { Button } from "./widgets/Button";
import { PillToggle } from "./widgets/PillToggle";
import { Popup } from "./widgets/Popup";

const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

const SCALES: { id: string; label: string }[] = [
  { id: "minorPent", label: "Minor Pent" },
  { id: "minor", label: "Minor" },
  { id: "phrygian", label: "Phrygian" },
  { id: "dorian", label: "Dorian" },
  { id: "harmonicMinor", label: "Harm. Minor" },
  { id: "phrygianDominant", label: "Phryg. Dom" },
  { id: "blues", label: "Blues" },
];

/** 16 Takte = 256 Steps. Jeder Takt ist ein TD-3-Pattern (16 Steps). */
const BARS = [1, 2, 4, 8, 16];
const STEPS = 16;
const LEVELS = [0, 0.25, 0.5, 0.75, 1];
const LEVEL_LABELS = ["Off", "Low", "Mid", "High", "Max"];

/** Tonumfang des TD-3 (MIDI) — muss zu `LOW_NOTE`/`HIGH_NOTE` in td3.rs passen. */
const LOW_NOTE = 24;
const HIGH_NOTE = 60;
/** Die drei Oktaven der Klaviatur im Input-Modus (Down / Normal / Up). */
const OCTAVES: { base: number; label: string }[] = [
  { base: 24, label: "Low" },
  { base: 36, label: "Mid" },
  { base: 48, label: "High" },
];
const LENGTHS: { v: number; label: string }[] = [
  { v: 0.25, label: "Stac" },
  { v: 0.55, label: "Norm" },
  { v: 1, label: "Full" },
  { v: 2, label: "2" },
  { v: 3, label: "3" },
  { v: 4, label: "4" },
];
const DEFAULT_LEN = 0.55;

interface Td3Step {
  note: number;
  accent: boolean;
  slide: boolean;
  /** Gewünschte Länge in Steps (bei Slide gilt die feste Überlappung). */
  len: number;
}
type Pattern = (Td3Step | null)[][];

interface Settings {
  root: number;
  scale: string;
  bars: number;
  density: number;
  accent: number;
  slide: number;
  octaves: number;
  seed: number;
}

const DEFAULTS: Settings = { root: 0, scale: "minorPent", bars: 1, density: 0.75, accent: 0.5, slide: 0.25, octaves: 0.25, seed: 1 };
const STORAGE_KEY = "midireef.td3";

const newSeed = () => Math.floor(Math.random() * 1_000_000_000);

/** Zuletzt benutzte Einstellung — der Dialog startet damit, und "⚡ Quick" in
 *  der Bibliothek würfelt mit ihr, ohne den Dialog zu öffnen. */
function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Settings>;
      return {
        root: Number.isInteger(v.root) ? Math.max(0, Math.min(11, v.root!)) : DEFAULTS.root,
        scale: SCALES.some((s) => s.id === v.scale) ? v.scale! : DEFAULTS.scale,
        bars: BARS.includes(v.bars as number) ? v.bars! : DEFAULTS.bars,
        density: num(v.density, DEFAULTS.density),
        accent: num(v.accent, DEFAULTS.accent),
        slide: num(v.slide, DEFAULTS.slide),
        octaves: num(v.octaves, DEFAULTS.octaves),
        seed: DEFAULTS.seed,
      };
    }
  } catch {
    /* Privatmodus / kaputter Eintrag — Standardwerte */
  }
  return { ...DEFAULTS };
}
const num = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);

function saveSettings(s: Settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* egal */
  }
}

/** Ein Klick: neues TD-3-Pattern mit der zuletzt benutzten Einstellung (und
 *  frischem Seed) als Melodie-Baustein in die Bibliothek legen. */
export function quickTd3(send: ReturnType<typeof useSend>) {
  send({ t: "td3.toBlock", ...loadSettings(), seed: newSeed(), name: "TD3" });
}

/** Wie `resolve_slides`/`from_pattern` im Server: Slide nur in einen direkt
 *  folgenden Step ANDERER Tonhöhe. Hier nur, damit die Anzeige nach einer
 *  Eingabe sofort stimmt — maßgeblich bleibt der Server. */
function fixSlides(p: Pattern): Pattern {
  for (const bar of p) {
    for (let s = 0; s < bar.length; s++) {
      const cur = bar[s];
      const next = bar[s + 1];
      if (cur && cur.slide && !(next && next.note !== cur.note)) cur.slide = false;
    }
  }
  return p;
}

const clonePattern = (p: Pattern): Pattern => p.map((bar) => bar.map((s) => (s ? { ...s } : null)));
const emptyBar = (): (Td3Step | null)[] => Array.from({ length: STEPS }, () => null);

/** Steps Platz von Step `g` bis zur nächsten Note bzw. zum Ende des Bausteins. */
function roomAt(p: Pattern, g: number): number {
  const total = p.length * STEPS;
  for (let i = g + 1; i < total; i++) if (p[Math.floor(i / STEPS)][i % STEPS]) return i - g;
  return total - g;
}

export interface Td3MelodyProps {
  onClose: () => void;
  onOpenBlock: (blockId: string) => void;
}

export function Td3Melody({ onClose, onOpenBlock }: Td3MelodyProps) {
  const net = useNet();
  const send = useSend();
  const [set, setSet] = useState<Settings>(() => ({ ...loadSettings(), seed: newSeed() }));
  const [loop, setLoop] = useState(true);
  const [listening, setListening] = useState(false);
  const [pattern, setPatternState] = useState<Pattern | null>(null);
  const [view, setView] = useState<"gen" | "input">("gen");
  const [sel, setSel] = useState<number | null>(null);
  const [octave, setOctave] = useState(36);
  const [advance, setAdvance] = useState(true);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref-Spiegel für Antwort-Handler und Timer, die sonst veraltete Werte sähen.
  const setRef = useRef(set);
  setRef.current = set;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const patternRef = useRef<Pattern | null>(null);
  /** "gen": der Server würfelt aus `set`. "edit": `patternRef` ist maßgeblich. */
  const modeRef = useRef<"gen" | "edit">("gen");
  /** Es gibt eine Änderung, die noch nicht beim Server ist. */
  const dirtyRef = useRef(false);
  /** Bars-Wechsel im "edit"-Modus: Pattern wird gekürzt/verlängert statt neu gewürfelt. */
  const resizeRef = useRef(false);
  const draftRef = useRef<string | null>(null);
  const inflight = useRef(false);
  const queued = useRef<{ listen: boolean } | null>(null);
  const syncTimer = useRef<number | undefined>(undefined);

  const setPattern = useCallback((p: Pattern | null) => {
    patternRef.current = p;
    setPatternState(p);
  }, []);

  const push = useCallback(
    (listen: boolean) => {
      if (inflight.current) {
        queued.current = { listen: listen || (queued.current?.listen ?? false) };
        return;
      }
      inflight.current = true;
      dirtyRef.current = false;
      const base = {
        t: "td3.toBlock",
        blockId: draftRef.current ?? undefined,
        name: "TD3",
        listen,
        loop: loopRef.current,
      };
      send(
        modeRef.current === "edit" && patternRef.current
          ? { ...base, pattern: patternRef.current }
          : { ...base, ...setRef.current },
      );
    },
    [send],
  );

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "td3.blockReady") {
        draftRef.current = evt.blockId;
        inflight.current = false;
        setError(null);
        const q = queued.current;
        // Eine Antwort auf einen schon überholten Stand nicht anzeigen — sonst
        // springt schnelles Tippen kurz zurück.
        if (!q && !dirtyRef.current) setPattern(evt.pattern);
        if (q) {
          queued.current = null;
          push(q.listen);
        }
      } else if (evt.t === "td3.error" || evt.t === "control.sendError") {
        inflight.current = false;
        setListening(false);
        setError(evt.message ?? "Something went wrong.");
      }
    });
    return off;
  }, [net, push, setPattern]);

  const schedule = useCallback(
    (mode: "gen" | "edit") => {
      modeRef.current = mode;
      dirtyRef.current = true;
      window.clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(() => push(false), 120);
    },
    [push],
  );

  // Generator-Regler (und das erste Öffnen) würfeln neu und ziehen den Entwurf
  // nach — eine laufende Vorschau übernimmt es live, ohne neu zu starten.
  useEffect(() => {
    saveSettings(set);
    if (resizeRef.current) {
      resizeRef.current = false;
      return;
    }
    setEdited(false);
    schedule("gen");
    return () => window.clearTimeout(syncTimer.current);
  }, [set, schedule]);

  const stopPlayback = useCallback(() => {
    send({ t: "block.stopPreview" });
    setListening(false);
  }, [send]);

  useEffect(
    () => () => {
      window.clearTimeout(syncTimer.current);
      send({ t: "block.stopPreview" });
    },
    [send],
  );

  const update = (patch: Partial<Settings>) => setSet((s) => ({ ...s, ...patch }));

  /** Handbearbeitung: Änderung auf eine Kopie, sofort anzeigen, an den Server. */
  const edit = (fn: (p: Pattern) => void) => {
    const cur = patternRef.current;
    if (!cur) return;
    const next = clonePattern(cur);
    fn(next);
    setPattern(fixSlides(next));
    setEdited(true);
    schedule("edit");
  };

  const setBars = (bars: number) => {
    if (modeRef.current === "edit" && patternRef.current) {
      // Handarbeit bleibt: kürzen oder leere Takte anhängen.
      resizeRef.current = true;
      edit((p) => {
        while (p.length > bars) p.pop();
        while (p.length < bars) p.push(emptyBar());
      });
      setSel((s) => (s != null && s >= bars * STEPS ? null : s));
    }
    update({ bars });
  };

  const blank = () => {
    setPattern(Array.from({ length: set.bars }, emptyBar));
    setEdited(true);
    schedule("edit");
    setView("input");
    setSel(0);
  };

  const discard = () => {
    if (draftRef.current) send({ t: "block.delete", blockId: draftRef.current });
    draftRef.current = null;
  };

  const cancel = () => {
    stopPlayback();
    discard();
    onClose();
  };

  const keep = (open: boolean) => {
    stopPlayback();
    window.clearTimeout(syncTimer.current);
    // Erst schließen, wenn der Server den LETZTEN Stand hat — beim Schließen
    // wird der Antwort-Handler abgehängt, eine dann noch wartende Änderung
    // (oder der noch nicht angelegte Entwurf) ginge sonst verloren.
    const settled = () => !inflight.current && !queued.current && !dirtyRef.current && !!draftRef.current;
    const finish = () => {
      const id = draftRef.current;
      onClose();
      if (open && id) onOpenBlock(id);
    };
    if (dirtyRef.current || !draftRef.current) push(false);
    if (settled()) return finish();
    const off = net.onEvent((evt) => {
      if (evt.t === "td3.blockReady" && settled()) {
        off();
        finish();
      }
    });
  };

  const listen = () => {
    setListening(true);
    push(true);
  };

  // ── Step-Eingabe ──────────────────────────────────────────────────────────

  const select = (g: number) => {
    setSel(g);
    setView("input");
    const st = patternRef.current?.[Math.floor(g / STEPS)]?.[g % STEPS];
    if (st) setOctave(Math.min(48, Math.max(24, Math.floor(st.note / 12) * 12)));
  };

  const total = (pattern?.length ?? 0) * STEPS;
  const moveTo = (g: number) => {
    if (g >= 0 && g < total) select(g);
  };

  const at = (g: number) => pattern?.[Math.floor(g / STEPS)]?.[g % STEPS] ?? null;
  const patch = (g: number, fn: (s: Td3Step) => void) =>
    edit((p) => {
      const s = p[Math.floor(g / STEPS)][g % STEPS];
      if (s) fn(s);
    });

  /** Klaviatur-Tipper: Ton setzen (Pause wird zur Note, Accent/Glide/Länge
   *  einer vorhandenen Note bleiben) und zum nächsten Step springen. */
  const playKey = (g: number, note: number) => {
    edit((p) => {
      const cur = p[Math.floor(g / STEPS)][g % STEPS];
      p[Math.floor(g / STEPS)][g % STEPS] = cur
        ? { ...cur, note }
        : { note, accent: false, slide: false, len: DEFAULT_LEN };
    });
    if (advance) moveTo(g + 1);
  };

  const rest = (g: number) => {
    edit((p) => {
      p[Math.floor(g / STEPS)][g % STEPS] = null;
    });
    if (advance) moveTo(g + 1);
  };

  const cur = sel != null ? at(sel) : null;
  const summary = pattern ? summarize(pattern) : null;

  return (
    <Popup onClose={cancel} fullscreen>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 16, gap: 10, minHeight: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="popup-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
            TD-3 Melody
          </div>
          <Button variant={view === "gen" ? "active" : "alt"} style={{ width: 96, height: 34, fontSize: 14 }} onClick={() => setView("gen")}>
            Generate
          </Button>
          <Button variant={view === "input" ? "active" : "alt"} style={{ width: 80, height: 34, fontSize: 14 }} onClick={() => setView("input")}>
            Input
          </Button>
          <Button variant="danger" style={{ height: 34, padding: "0 14px", fontSize: 14 }} onClick={cancel}>
            Close
          </Button>
        </div>

        {error && <div style={{ color: "var(--pal-stop)", fontSize: 14 }}>{error}</div>}

        {view === "gen" ? (
          <>
            <Row label="Key">
              {KEYS.map((k, i) => (
                <Chip key={k} on={set.root === i} w={44} onClick={() => update({ root: i })}>
                  {k}
                </Chip>
              ))}
            </Row>
            <Row label="Scale">
              {SCALES.map((s) => (
                <Chip key={s.id} on={set.scale === s.id} w={104} onClick={() => update({ scale: s.id })}>
                  {s.label}
                </Chip>
              ))}
            </Row>
            <Row label="Bars">
              {BARS.map((b) => (
                <Chip key={b} on={set.bars === b} w={48} onClick={() => setBars(b)}>
                  {b}
                </Chip>
              ))}
              <span style={{ fontSize: 12, color: "var(--pal-text-dim)", marginLeft: 6 }}>= {set.bars * STEPS} steps</span>
            </Row>
            <Level label="Notes" hint="how many steps play" value={set.density} onChange={(v) => update({ density: v })} />
            <Level label="Accent" value={set.accent} onChange={(v) => update({ accent: v })} />
            <Level label="Slide" value={set.slide} onChange={(v) => update({ slide: v })} />
            <Level label="Octaves" hint="jumps down / up" value={set.octaves} onChange={(v) => update({ octaves: v })} />
            {edited && (
              <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
                Edited by hand — turning key, scale, a level or 🎲 rewrites the pattern.
              </div>
            )}
          </>
        ) : (
          <StepPanel
            sel={sel}
            total={total}
            cur={cur}
            octave={octave}
            setOctave={setOctave}
            advance={advance}
            setAdvance={setAdvance}
            canSlide={sel != null && !!cur && !!at(sel + 1) && at(sel + 1)!.note !== cur.note && (sel + 1) % STEPS !== 0}
            room={sel != null && pattern ? roomAt(pattern, sel) : 1}
            onKey={(note) => sel != null && playKey(sel, note)}
            onRest={() => sel != null && rest(sel)}
            onMove={moveTo}
            onAccent={() => sel != null && patch(sel, (s) => (s.accent = !s.accent))}
            onSlide={() => sel != null && patch(sel, (s) => (s.slide = !s.slide))}
            onLen={(v) => sel != null && patch(sel, (s) => (s.len = v))}
            onShift={(d) => sel != null && patch(sel, (s) => (s.note = Math.max(LOW_NOTE, Math.min(HIGH_NOTE, s.note + d))))}
            onBlank={blank}
          />
        )}

        {pattern && <PatternView pattern={pattern} sel={view === "input" ? sel : null} onSelect={select} />}

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button
            variant={listening ? "danger" : "alt"}
            style={{ width: 130, height: 48, fontSize: 17 }}
            onClick={listening ? stopPlayback : listen}
          >
            {listening ? "■ Stop" : "▶ Listen"}
          </Button>
          <PillToggle letter="L" active={loop} onToggle={() => setLoop((v) => !v)} />
          <Button style={{ width: 90, height: 48, fontSize: 16 }} onClick={() => update({ seed: newSeed() })}>
            🎲 Roll
          </Button>
          <span style={{ fontSize: 13, color: "var(--pal-text-dim)", flex: 1, minWidth: 120 }}>
            {summary
              ? summary.notes
                ? `${summary.steps} steps · ${summary.notes} notes · ${summary.accents} accents · ${summary.slides} slides · ${noteName(summary.low)}–${noteName(summary.high)}`
                : `${summary.steps} steps · empty`
              : "Generating…"}
          </span>
          <Button style={{ height: 48, padding: "0 16px", fontSize: 16 }} onClick={() => keep(false)}>
            Add to library
          </Button>
          <Button variant="active" style={{ height: 48, padding: "0 16px", fontSize: 16 }} onClick={() => keep(true)}>
            Add &amp; edit
          </Button>
        </div>
      </div>
    </Popup>
  );
}

function summarize(pattern: Pattern) {
  const steps = pattern.flat().filter((s): s is Td3Step => !!s);
  return {
    steps: pattern.length * STEPS,
    notes: steps.length,
    accents: steps.filter((s) => s.accent).length,
    slides: steps.filter((s) => s.slide).length,
    low: steps.length ? Math.min(...steps.map((s) => s.note)) : 0,
    high: steps.length ? Math.max(...steps.map((s) => s.note)) : 0,
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      <span style={{ width: 64, fontSize: 14, color: "var(--pal-text-dim)" }}>{label}</span>
      {children}
    </div>
  );
}

function Chip({
  on,
  w,
  onClick,
  children,
  variant,
  disabled,
}: {
  on: boolean;
  w: number;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "default" | "alt";
  disabled?: boolean;
}) {
  return (
    <Button
      variant={on ? "active" : (variant ?? "default")}
      disabled={disabled}
      style={{ width: w, height: 40, fontSize: 14, padding: 0 }}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Level({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  const idx = LEVELS.reduce((best, l, i) => (Math.abs(l - value) < Math.abs(LEVELS[best] - value) ? i : best), 0);
  return (
    <Row label={label}>
      {LEVELS.map((l, i) => (
        <Chip key={l} on={i === idx} w={64} onClick={() => onChange(l)}>
          {LEVEL_LABELS[i]}
        </Chip>
      ))}
      {hint && <span style={{ fontSize: 12, color: "var(--pal-text-dim)", marginLeft: 6 }}>{hint}</span>}
    </Row>
  );
}

/** Eingabe-Leiste für den gewählten Step: Klaviatur (tippen = Ton setzen und
 *  weiter), Pause, Accent, Glide, Länge, Tonhöhe ±. Bewusst direkt im Dialog
 *  statt in einem Popup je Step — jedes Popup wäre ein Tipper mehr pro Note. */
function StepPanel({
  sel,
  total,
  cur,
  octave,
  setOctave,
  advance,
  setAdvance,
  canSlide,
  room,
  onKey,
  onRest,
  onMove,
  onAccent,
  onSlide,
  onLen,
  onShift,
  onBlank,
}: {
  sel: number | null;
  total: number;
  cur: Td3Step | null;
  octave: number;
  setOctave: (o: number) => void;
  advance: boolean;
  setAdvance: (v: boolean) => void;
  canSlide: boolean;
  room: number;
  onKey: (note: number) => void;
  onRest: () => void;
  onMove: (g: number) => void;
  onAccent: () => void;
  onSlide: () => void;
  onLen: (v: number) => void;
  onShift: (d: number) => void;
  onBlank: () => void;
}) {
  if (sel == null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, color: "var(--pal-text-dim)", flex: 1, minWidth: 200 }}>
          Tap a step below, then tap notes — the cursor moves on by itself.
        </span>
        <Button style={{ height: 40, padding: "0 14px", fontSize: 14 }} onClick={onBlank}>
          ✎ Start blank
        </Button>
      </div>
    );
  }
  const barNo = Math.floor(sel / STEPS) + 1;
  const stepNo = (sel % STEPS) + 1;
  const sliding = !!cur?.slide;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button style={{ width: 44, height: 40, fontSize: 18 }} disabled={sel <= 0} onClick={() => onMove(sel - 1)}>
          ◀
        </Button>
        <span style={{ minWidth: 110, textAlign: "center", fontSize: 15, fontWeight: 700 }}>
          Bar {barNo} · Step {stepNo}
          {cur ? ` · ${noteName(cur.note)}` : " · rest"}
        </span>
        <Button style={{ width: 44, height: 40, fontSize: 18 }} disabled={sel >= total - 1} onClick={() => onMove(sel + 1)}>
          ▶
        </Button>
        <span style={{ width: 8 }} />
        {OCTAVES.map((o) => (
          <Chip key={o.base} on={octave === o.base} w={58} variant="alt" onClick={() => setOctave(o.base)}>
            {o.label}
          </Chip>
        ))}
        <span style={{ fontSize: 13, color: "var(--pal-text-dim)", marginLeft: 6 }}>Next</span>
        <PillToggle letter="→" active={advance} onToggle={() => setAdvance(!advance)} />
        <Button style={{ height: 40, padding: "0 12px", fontSize: 13 }} onClick={onBlank}>
          ✎ Blank
        </Button>
      </div>

      {/* 13 Tasten: C … B und das C darüber. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {Array.from({ length: 13 }, (_, i) => {
          const note = octave + i;
          return (
            <Button
              key={i}
              variant={cur?.note === note ? "active" : BLACK.has(i % 12) ? "default" : "alt"}
              disabled={note > HIGH_NOTE}
              style={{ width: 52, height: 52, fontSize: 15, padding: 0, fontWeight: BLACK.has(i % 12) ? 500 : 700 }}
              onClick={() => onKey(note)}
            >
              {KEYS[i % 12]}
            </Button>
          );
        })}
        <Button variant="danger" style={{ width: 64, height: 52, fontSize: 14, padding: 0 }} onClick={onRest}>
          Rest
        </Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", opacity: cur ? 1 : 0.4 }}>
        <Chip on={!!cur?.accent} w={80} disabled={!cur} onClick={onAccent}>
          Accent
        </Chip>
        <Chip on={sliding} w={80} disabled={!cur || (!canSlide && !sliding)} onClick={onSlide}>
          Glide
        </Chip>
        <span style={{ width: 6 }} />
        {LENGTHS.map((l) => (
          <Chip
            key={l.v}
            on={!sliding && !!cur && Math.abs(cur.len - l.v) < 0.01}
            w={52}
            disabled={!cur || sliding || l.v > room}
            onClick={() => onLen(l.v)}
          >
            {l.label}
          </Chip>
        ))}
        <span style={{ width: 6 }} />
        {[-12, -1, 1, 12].map((d) => (
          <Chip key={d} on={false} w={46} variant="alt" disabled={!cur} onClick={() => onShift(d)}>
            {d > 0 ? `+${d}` : d}
          </Chip>
        ))}
      </div>
      {cur && (
        <div style={{ fontSize: 12, color: "var(--pal-text-dim)" }}>
          {sliding
            ? "Glide: the note is held into the next step, so the pitch slides."
            : canSlide
              ? "Length 2–4 holds the note over empty steps (tie)."
              : "Glide needs a different note on the very next step."}
        </div>
      )}
    </div>
  );
}

/** Wie das TD-3-Display: je Step der Ton, darüber ein A bei Accent, darunter
 *  ein Balken bei Glide, bei langer Note ein Streifen. Antippen wählt den Step
 *  für die Eingabe. Ab 4 Takten scrollt die Liste in sich. */
function PatternView({ pattern, sel, onSelect }: { pattern: Pattern; sel: number | null; onSelect: (g: number) => void }) {
  const selRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 250, overflowY: "auto", flexShrink: 0 }}>
      {pattern.map((bar, b) => (
        <div key={b} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {pattern.length > 1 && <span style={{ width: 18, fontSize: 11, color: "var(--pal-text-dim)", textAlign: "right" }}>{b + 1}</span>}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(16, minmax(0, 1fr))", gap: 3 }}>
            {bar.map((st, s) => {
              const g = b * STEPS + s;
              const selected = sel === g;
              return (
                <div
                  key={s}
                  ref={selected ? selRef : undefined}
                  onClick={() => onSelect(g)}
                  style={{
                    position: "relative",
                    height: 42,
                    borderRadius: 5,
                    cursor: "pointer",
                    background: st ? "var(--pal-btn-alt)" : "var(--pal-panel-deep)",
                    border: selected ? "2px solid var(--pal-btn-active)" : `1px solid rgba(255,255,255,${s % 4 === 0 ? 0.28 : 0.12})`,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--pal-text)",
                  }}
                >
                  {st && (
                    <>
                      <span style={{ height: 12, lineHeight: "12px", color: st.accent ? "var(--pal-stop)" : "transparent" }}>A</span>
                      <span>{noteName(st.note)}</span>
                      {st.slide ? (
                        <span style={{ position: "absolute", left: "50%", right: -5, bottom: 3, height: 3, borderRadius: 2, background: "var(--pal-run)" }} />
                      ) : (
                        st.len >= 1.5 && (
                          <span style={{ position: "absolute", left: "50%", right: -5, bottom: 3, height: 3, borderRadius: 2, background: "var(--pal-text-dim)" }} />
                        )
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
