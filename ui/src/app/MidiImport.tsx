//! MIDI-Import: eine Datei aus der MIDI-Bibliothek öffnen, einen Ausschnitt
//! (Takte, Spuren) wählen, probehören und als Melodie-Baustein behalten.
//!
//! "Probehören" legt den Ausschnitt als echten Melodie-Baustein an (Entwurf)
//! und spielt ihn über die normale Baustein-Vorschau (`block.play`-Weg im
//! Server) — dasselbe, was man danach im Editor hört. Ändert man Takte oder
//! Spuren, wird der Entwurf nachgezogen, eine laufende Schleife spielt weiter.
//! "Abbrechen" löscht den Entwurf wieder; "Behalten" lässt ihn in der
//! Bibliothek stehen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNet, useSend, useStoreValue } from "./store";
import { Button } from "./widgets/Button";
import { PillToggle } from "./widgets/PillToggle";
import { Popup } from "./widgets/Popup";
import { useTouchKeyboard } from "./TouchKeyboard";

interface LibFile {
  id: string;
  name: string;
  folder: string;
  composer: string;
  style: string;
  license: string;
  bytes: number;
}

interface MidiTrackInfo {
  index: number;
  name: string;
  channel: number | null;
  drums: boolean;
  /** [startBeat, lenBeats, note, velocity] */
  notes: [number, number, number, number][];
}

interface MidiFileInfo {
  file: string;
  bpm: number;
  timeSignature: string;
  beatsPerBar: number;
  totalBeats: number;
  tracks: MidiTrackInfo[];
}

const LENGTHS = [1, 2, 4, 8, 16];
const ROLL_H = 150;
const MAP_H = 30;
const MIN_PPB = 2;
const MAX_PPB = 60;

export interface MidiImportProps {
  onClose: () => void;
  onOpenBlock: (blockId: string) => void;
}

export function MidiImport({ onClose, onOpenBlock }: MidiImportProps) {
  const net = useNet();
  const send = useSend();
  const projectBpm = useStoreValue((s) => (s.project?.bpm as number | undefined) ?? 120);

  const [files, setFiles] = useState<LibFile[] | null>(null);
  const [folder, setFolder] = useState<string>("");
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState<MidiFileInfo | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [trackSel, setTrackSel] = useState<Set<number>>(new Set());
  const [startBar, setStartBar] = useState(0);
  const [lenBars, setLenBars] = useState(4);
  const [loop, setLoop] = useState(true);
  const [listening, setListening] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [result, setResult] = useState<{ noteCount: number; lengthBars: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs für die Antwort-Handler / Timer, die sonst veraltete Werte sähen.
  const draftRef = useRef<string | null>(null);
  const inflight = useRef(false);
  const queued = useRef<{ listen: boolean } | null>(null);
  const stopTimer = useRef<number | undefined>(undefined);
  const syncTimer = useRef<number | undefined>(undefined);

  const bpb = info?.beatsPerBar ?? 4;
  const totalBars = info ? Math.max(1, Math.ceil(info.totalBeats / bpb)) : 1;

  // Server-Antworten.
  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "midi.files") {
        setFiles(evt.files ?? []);
      } else if (evt.t === "midi.file") {
        const f = evt as MidiFileInfo;
        setInfo(f);
        setLoading(null);
        setError(null);
        // Standard: alle Spuren außer Schlagzeug, sonst alle.
        const melodic = f.tracks.filter((t) => !t.drums);
        setTrackSel(new Set((melodic.length ? melodic : f.tracks).map((t) => t.index)));
        setStartBar(0);
        setLenBars(Math.min(4, Math.max(1, Math.ceil(f.totalBeats / f.beatsPerBar))));
      } else if (evt.t === "midi.blockReady") {
        draftRef.current = evt.blockId;
        setDraftId(evt.blockId);
        setResult({ noteCount: evt.noteCount, lengthBars: evt.lengthBars });
        setError(null);
        inflight.current = false;
        const q = queued.current;
        if (q) {
          queued.current = null;
          pushSelection(q.listen);
        }
      } else if (evt.t === "midi.error" || evt.t === "control.sendError") {
        setLoading(null);
        setListening(false);
        inflight.current = false;
        setError(evt.message ?? "Something went wrong.");
      }
    });
    send({ t: "midi.list" });
    return off;
    // pushSelection liest nur Refs/aktuelle Closure über selRef (s.u.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net, send]);

  // Aktuelle Auswahl als Ref, damit `pushSelection` aus Event-Handlern und
  // Timern immer den neuesten Stand schickt.
  const selRef = useRef({ info, trackSel, startBar, lenBars, loop });
  selRef.current = { info, trackSel, startBar, lenBars, loop };

  const pushSelection = useCallback(
    (listen: boolean) => {
      const { info, trackSel, startBar, lenBars, loop } = selRef.current;
      if (!info) return;
      if (inflight.current) {
        queued.current = { listen: listen || (queued.current?.listen ?? false) };
        return;
      }
      inflight.current = true;
      const base = info.file.split("/").pop() ?? "";
      send({
        t: "midi.toBlock",
        file: info.file,
        tracks: [...trackSel],
        startBeat: startBar * info.beatsPerBar,
        endBeat: (startBar + lenBars) * info.beatsPerBar,
        blockId: draftRef.current ?? undefined,
        name: base.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "MIDI",
        listen,
        loop,
      });
    },
    [send],
  );

  const stopPlayback = useCallback(() => {
    window.clearTimeout(stopTimer.current);
    send({ t: "block.stopPreview" });
    setListening(false);
  }, [send]);

  // Auswahl geändert, während ein Entwurf existiert → nachziehen (ohne neu zu
  // starten; eine laufende Vorschau übernimmt es live).
  useEffect(() => {
    if (!draftRef.current || !info) return;
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => pushSelection(false), 200);
    return () => window.clearTimeout(syncTimer.current);
  }, [info, trackSel, startBar, lenBars, pushSelection]);

  // Beim Verlassen immer die Vorschau beenden.
  useEffect(
    () => () => {
      window.clearTimeout(stopTimer.current);
      window.clearTimeout(syncTimer.current);
      send({ t: "block.stopPreview" });
    },
    [send],
  );

  const listen = () => {
    if (!info || trackSel.size === 0) return;
    setListening(true);
    pushSelection(true);
    window.clearTimeout(stopTimer.current);
    if (!loop) {
      // Einmal-Vorschau endet serverseitig still — Knopf nach der Dauer zurücksetzen.
      const secs = (lenBars * info.beatsPerBar * 60) / Math.max(1, projectBpm);
      stopTimer.current = window.setTimeout(() => setListening(false), secs * 1000 + 300);
    }
  };

  const openFile = (id: string) => {
    setLoading(id);
    setError(null);
    send({ t: "midi.open", file: id });
  };

  const discardDraft = () => {
    if (draftRef.current) send({ t: "block.delete", blockId: draftRef.current });
    draftRef.current = null;
    setDraftId(null);
    setResult(null);
  };

  const backToFiles = () => {
    stopPlayback();
    discardDraft();
    setInfo(null);
  };

  const cancel = () => {
    stopPlayback();
    discardDraft();
    onClose();
  };

  const keep = (edit: boolean) => {
    stopPlayback();
    const id = draftRef.current;
    if (!id) {
      // Noch nie angehört: jetzt anlegen, ohne Vorschau.
      pushSelection(false);
      const off = net.onEvent((evt) => {
        if (evt.t === "midi.blockReady") {
          off();
          onClose();
          if (edit) onOpenBlock(evt.blockId);
        }
      });
      return;
    }
    // Der Entwurf wird zum bleibenden Baustein (gelöscht wird nur über
    // Abbrechen/Zurück) — eine ausstehende Änderung noch senden.
    window.clearTimeout(syncTimer.current);
    pushSelection(false);
    onClose();
    if (edit) onOpenBlock(id);
  };

  const folders = useMemo(() => [...new Set((files ?? []).map((f) => f.folder))].sort(), [files]);
  const index = useMemo(() => (files ?? []).map((f) => ({ f, name: fold(f.name), hay: fold(`${f.name} ${f.composer} ${f.style} ${f.folder} ${f.license}`) })), [files]);
  const shown = useMemo(() => searchFiles(index, query, folder), [index, query, folder]);
  const title = info ? (files?.find((f) => f.id === info.file)?.name ?? info.file.split("/").pop()?.replace(/\.(mid|midi|kar)$/i, "").replace(/-/g, " ")) : "Import MIDI";

  return (
    <Popup onClose={cancel} fullscreen>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 16, gap: 10, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {info && (
            <Button style={{ height: 34, padding: "0 12px", fontSize: 14 }} onClick={backToFiles}>
              ← Files
            </Button>
          )}
          <div className="popup-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>
            {title}
          </div>
          <Button variant="danger" style={{ height: 34, padding: "0 14px", fontSize: 14 }} onClick={cancel}>
            Close
          </Button>
        </div>

        {error && <div style={{ color: "var(--pal-stop)", fontSize: 14 }}>{error}</div>}

        {!info ? (
          <FileList
            files={shown}
            loaded={files !== null}
            total={files?.length ?? 0}
            folders={folders}
            folder={folder}
            onFolder={setFolder}
            query={query}
            onQuery={setQuery}
            loading={loading}
            onPick={openFile}
          />
        ) : (
          <>
            <div className="popup-subtitle" style={{ margin: 0 }}>
              {Math.round(info.bpm)} bpm in the file · {info.timeSignature} · {totalBars} bars. Tap the roll to choose
              where the part starts, then pick how long. Plays at the project tempo ({Math.round(projectBpm)} bpm).
            </div>

            <TrackChips
              tracks={info.tracks}
              sel={trackSel}
              onToggle={(i) =>
                setTrackSel((s) => {
                  const n = new Set(s);
                  if (n.has(i)) n.delete(i);
                  else n.add(i);
                  return n;
                })
              }
            />

            <MidiRoll
              info={info}
              trackSel={trackSel}
              startBar={startBar}
              lenBars={lenBars}
              totalBars={totalBars}
              onPickBar={(b) => setStartBar(Math.max(0, Math.min(totalBars - 1, b)))}
            />

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, color: "var(--pal-text-dim)" }}>Start bar</span>
              <Button style={{ width: 44, height: 40, fontSize: 18 }} onClick={() => setStartBar((b) => Math.max(0, b - 1))}>
                ◀
              </Button>
              <span style={{ minWidth: 36, textAlign: "center", fontSize: 18, fontWeight: 700 }}>{startBar + 1}</span>
              <Button
                style={{ width: 44, height: 40, fontSize: 18 }}
                onClick={() => setStartBar((b) => Math.min(totalBars - 1, b + 1))}
              >
                ▶
              </Button>
              <span style={{ fontSize: 14, color: "var(--pal-text-dim)", marginLeft: 12 }}>Length</span>
              {LENGTHS.map((n) => (
                <Button
                  key={n}
                  variant={n === lenBars ? "active" : "default"}
                  style={{ width: 48, height: 40, fontSize: 15 }}
                  onClick={() => setLenBars(n)}
                >
                  {n}
                </Button>
              ))}
              <span style={{ fontSize: 14, color: "var(--pal-text-dim)" }}>bars</span>
            </div>

            <div style={{ flex: 1 }} />

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Button
                variant={listening ? "danger" : "alt"}
                style={{ width: 130, height: 48, fontSize: 17 }}
                disabled={trackSel.size === 0}
                onClick={listening ? stopPlayback : listen}
              >
                {listening ? "■ Stop" : "▶ Listen"}
              </Button>
              <PillToggle letter="L" active={loop} onToggle={() => setLoop((v) => !v)} />
              <span style={{ fontSize: 13, color: "var(--pal-text-dim)", flex: 1, minWidth: 120 }}>
                {trackSel.size === 0
                  ? "Select at least one track."
                  : result && draftId
                    ? `${result.noteCount} notes · ${result.lengthBars} bar${result.lengthBars === 1 ? "" : "s"} as a melody block`
                    : "Listen to try it as a melody block."}
              </span>
              <Button style={{ height: 48, padding: "0 16px", fontSize: 16 }} disabled={trackSel.size === 0} onClick={() => keep(false)}>
                Add to library
              </Button>
              <Button
                variant="active"
                style={{ height: 48, padding: "0 16px", fontSize: 16 }}
                disabled={trackSel.size === 0}
                onClick={() => keep(true)}
              >
                Add &amp; edit
              </Button>
            </div>
          </>
        )}
      </div>
    </Popup>
  );
}

/** Kleinschreibung ohne Akzente — "Étude" findet "etude". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

interface IndexedFile {
  f: LibFile;
  name: string;
  hay: string;
}

/** Alle Suchwörter müssen irgendwo vorkommen (Titel, Komponist, Stil, Ordner,
 *  Lizenz). Treffer am Titelanfang zuerst, dann im Titel, dann der Rest. */
function searchFiles(index: IndexedFile[], query: string, folder: string): LibFile[] {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  const scored: [number, LibFile][] = [];
  for (const { f, name, hay } of index) {
    if (folder && f.folder !== folder) continue;
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      if (name.startsWith(t)) score += 3;
      else if (name.includes(t)) score += 2;
      else if (hay.includes(t)) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push([score, f]);
  }
  if (tokens.length) scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return scored.map((x) => x[1]);
}

const PAGE = 80;

function FileList({
  files,
  loaded,
  total,
  folders,
  folder,
  onFolder,
  query,
  onQuery,
  loading,
  onPick,
}: {
  files: LibFile[];
  loaded: boolean;
  total: number;
  folders: string[];
  folder: string;
  onFolder: (f: string) => void;
  query: string;
  onQuery: (q: string) => void;
  loading: string | null;
  onPick: (id: string) => void;
}) {
  const openKeyboard = useTouchKeyboard();
  const [limit, setLimit] = useState(PAGE);
  // Neue Suche → wieder von oben.
  useEffect(() => setLimit(PAGE), [query, folder]);

  if (!loaded) return <div className="popup-subtitle">Loading…</div>;
  if (total === 0) {
    return (
      <div className="popup-subtitle">
        No MIDI files found. Put .mid files into the server's midi-library folder (or data/midi) and reopen this.
      </div>
    );
  }
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button
          style={{ flex: 1, height: 44, justifyContent: "flex-start", padding: "0 14px", fontSize: 16, fontWeight: 500 }}
          onClick={() => openKeyboard(query, 40, (v) => v !== null && onQuery(v.trim()))}
        >
          <span style={{ marginRight: 10 }}>🔍</span>
          <span style={{ color: query ? "var(--pal-text)" : "var(--pal-text-dim)" }}>
            {query || "Search title, composer, style…"}
          </span>
        </Button>
        {query && (
          <Button style={{ width: 44, height: 44, fontSize: 18 }} onClick={() => onQuery("")}>
            ✕
          </Button>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {["", ...folders].map((f) => (
          <Button
            key={f || "all"}
            variant={f === folder ? "active" : "default"}
            style={{ height: 34, padding: "0 12px", fontSize: 14 }}
            onClick={() => onFolder(f)}
          >
            {f || "All"}
          </Button>
        ))}
      </div>
      <div className="popup-subtitle" style={{ margin: 0 }}>
        {files.length === total ? `${total} files` : `${files.length} of ${total} files`}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {files.slice(0, limit).map((f) => (
          <Button
            key={f.id}
            variant={loading === f.id ? "active" : "default"}
            style={{ justifyContent: "space-between", height: 44, padding: "0 14px", fontSize: 15, flexShrink: 0 }}
            onClick={() => onPick(f.id)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
            <span
              style={{
                fontSize: 12,
                color: "var(--pal-text-dim)",
                marginLeft: 12,
                flexShrink: 0,
                maxWidth: "45%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {[f.composer || f.folder, f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`].join(" · ")}
            </span>
          </Button>
        ))}
        {files.length > limit && (
          <Button style={{ height: 44, flexShrink: 0 }} onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({files.length - limit})
          </Button>
        )}
        {files.length === 0 && <div className="popup-subtitle">No match.</div>}
      </div>
    </>
  );
}

function TrackChips({
  tracks,
  sel,
  onToggle,
}: {
  tracks: MidiTrackInfo[];
  sel: Set<number>;
  onToggle: (index: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {tracks.map((t, i) => (
        <Button
          key={t.index}
          variant={sel.has(t.index) ? "active" : "default"}
          style={{ height: 34, padding: "0 12px", fontSize: 13 }}
          onClick={() => onToggle(t.index)}
        >
          {t.name || `Track ${i + 1}`}
          {t.drums ? " (drums)" : ""} · {t.notes.length}
        </Button>
      ))}
    </div>
  );
}

/** Notenübersicht der Datei: Tippen setzt den Starttakt, Ziehen verschiebt,
 *  darunter eine Mini-Karte der ganzen Datei zum schnellen Springen. Es wird
 *  nur der sichtbare Ausschnitt gezeichnet — lange Dateien bleiben leicht. */
function MidiRoll({
  info,
  trackSel,
  startBar,
  lenBars,
  totalBars,
  onPickBar,
}: {
  info: MidiFileInfo;
  trackSel: Set<number>;
  startBar: number;
  lenBars: number;
  totalBars: number;
  onPickBar: (bar: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const roll = useRef<HTMLCanvasElement>(null);
  const map = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [ppb, setPpb] = useState(12);
  const [scroll, setScroll] = useState(0); // linker Rand in Beats
  const bpb = info.beatsPerBar;

  const [lo, hi] = useMemo(() => {
    let lo = 127;
    let hi = 0;
    for (const t of info.tracks) {
      if (!trackSel.has(t.index)) continue;
      for (const n of t.notes) {
        lo = Math.min(lo, n[2]);
        hi = Math.max(hi, n[2]);
      }
    }
    return hi < lo ? [48, 84] : [Math.max(0, lo - 1), Math.min(127, hi + 1)];
  }, [info, trackSel]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom so, dass die Datei (höchstens) ~40 Takte breit startet — sobald die
  // Breite bekannt ist, einmal je Datei.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (width === 0 || fitted.current === info.file) return;
    fitted.current = info.file;
    setPpb(Math.max(MIN_PPB, Math.min(MAX_PPB, width / Math.min(totalBars, 40) / bpb)));
    setScroll(0);
  }, [info.file, width, totalBars, bpb]);

  // Starttakt immer im Blick halten (Stepper, Sprung über die Mini-Karte).
  useEffect(() => {
    const s = startBar * bpb;
    const visible = width / ppb;
    if (s < scroll || s + lenBars * bpb > scroll + visible) {
      setScroll(Math.max(0, Math.min(info.totalBeats - visible * 0.5, s - bpb)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startBar]);

  const color = useCallback((name: string, fallback: string) => {
    const v = wrap.current ? getComputedStyle(wrap.current).getPropertyValue(name).trim() : "";
    return v || fallback;
  }, []);

  useEffect(() => {
    const cv = roll.current;
    if (!cv || width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = ROLL_H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    const text = color("--pal-text", "#f2f2f2");
    const dim = color("--pal-text-dim", "#8a8a8a");
    g.fillStyle = color("--pal-panel-deep", "#080808");
    g.fillRect(0, 0, width, ROLL_H);

    const x = (beat: number) => (beat - scroll) * ppb;
    const y = (note: number) => ROLL_H - 4 - ((note - lo + 0.5) / (hi - lo + 1)) * (ROLL_H - 8);
    const noteH = Math.max(1.5, Math.min(8, (ROLL_H - 8) / (hi - lo + 1) - 0.5));

    // Selektion
    g.fillStyle = "rgba(255,255,255,0.14)";
    g.fillRect(x(startBar * bpb), 0, lenBars * bpb * ppb, ROLL_H);

    // Taktlinien + Nummern (nur so dicht, wie sie lesbar bleiben).
    const barPx = bpb * ppb;
    const labelEvery = barPx >= 40 ? 1 : barPx >= 20 ? 2 : barPx >= 10 ? 4 : 8;
    g.font = "11px sans-serif";
    g.textBaseline = "top";
    for (let b = Math.floor(scroll / bpb); b * bpb < scroll + width / ppb; b++) {
      const bx = x(b * bpb);
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(Math.round(bx), 0, 1, ROLL_H);
      if (b % labelEvery === 0) {
        g.fillStyle = dim;
        g.fillText(String(b + 1), bx + 3, 2);
      }
    }

    // Noten: gewählte Spuren hell, andere gedämpft.
    const first = scroll;
    const last = scroll + width / ppb;
    for (const pass of [false, true]) {
      for (const t of info.tracks) {
        if (trackSel.has(t.index) !== pass) continue;
        g.fillStyle = pass ? text : "rgba(255,255,255,0.18)";
        for (const n of t.notes) {
          if (n[0] > last) break; // Noten sind nach Beginn sortiert
          if (n[0] + n[1] < first) continue;
          g.fillRect(x(n[0]), y(n[2]) - noteH / 2, Math.max(1.5, n[1] * ppb - 0.5), noteH);
        }
      }
    }

    // Auswahlrahmen
    g.strokeStyle = text;
    g.lineWidth = 2;
    g.strokeRect(x(startBar * bpb) + 1, 1, Math.max(2, lenBars * bpb * ppb - 2), ROLL_H - 2);
  }, [info, trackSel, startBar, lenBars, scroll, ppb, width, lo, hi, bpb, color]);

  // Mini-Karte: Dichte der gewählten Spuren über die ganze Datei.
  useEffect(() => {
    const cv = map.current;
    if (!cv || width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = MAP_H * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = color("--pal-panel-deep", "#080808");
    g.fillRect(0, 0, width, MAP_H);
    const k = width / Math.max(1, info.totalBeats);
    g.fillStyle = "rgba(255,255,255,0.5)";
    for (const t of info.tracks) {
      if (!trackSel.has(t.index)) continue;
      for (const n of t.notes) {
        const ny = MAP_H - 2 - ((n[2] - lo) / Math.max(1, hi - lo)) * (MAP_H - 4);
        g.fillRect(n[0] * k, ny, Math.max(1, n[1] * k), 1.5);
      }
    }
    g.fillStyle = "rgba(255,255,255,0.22)";
    g.fillRect(scroll * k, 0, (width / ppb) * k, MAP_H);
    g.fillStyle = color("--pal-run", "#2ecc71");
    g.fillRect(startBar * bpb * k, 0, Math.max(2, lenBars * bpb * k), 3);
  }, [info, trackSel, scroll, ppb, width, lo, hi, startBar, lenBars, bpb, color]);

  const maxScroll = Math.max(0, info.totalBeats - width / ppb / 2);
  const clampScroll = (s: number) => Math.max(0, Math.min(maxScroll, s));

  // Tippen = Starttakt, Ziehen = verschieben.
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, scroll, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 6) d.moved = true;
    if (d.moved) setScroll(clampScroll(d.scroll - dx / ppb));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = scroll + (e.clientX - rect.left) / ppb;
    onPickBar(Math.floor(beat / bpb));
  };

  const jump = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = ((e.clientX - rect.left) / rect.width) * info.totalBeats;
    setScroll(clampScroll(beat - width / ppb / 2));
  };

  const zoom = (f: number) => {
    const centre = scroll + width / ppb / 2;
    const next = Math.max(MIN_PPB, Math.min(MAX_PPB, ppb * f));
    setPpb(next);
    setScroll(Math.max(0, centre - width / next / 2));
  };

  return (
    <div ref={wrap} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ position: "relative" }}>
        <canvas
          ref={roll}
          style={{ width: "100%", height: ROLL_H, display: "block", borderRadius: 8, touchAction: "none" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => (drag.current = null)}
        />
        <div style={{ position: "absolute", right: 6, bottom: 6, display: "flex", gap: 6 }}>
          <Button style={{ width: 40, height: 36, fontSize: 20, opacity: 0.9 }} onClick={() => zoom(1 / 1.6)}>
            −
          </Button>
          <Button style={{ width: 40, height: 36, fontSize: 20, opacity: 0.9 }} onClick={() => zoom(1.6)}>
            +
          </Button>
        </div>
      </div>
      <canvas
        ref={map}
        style={{ width: "100%", height: MAP_H, display: "block", borderRadius: 6, touchAction: "none" }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          jump(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) jump(e);
        }}
      />
    </div>
  );
}
