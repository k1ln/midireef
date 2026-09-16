//! Ein-/Ausgangs-Auswahl + Aufnahmen-Verwaltung. Der eigentliche Inhalt
//! (`AudioRecorderPanel`) lebt an zwei Stellen: als Popup, geöffnet über den
//! „RC"-Knopf in der Transport-Leiste (s. Transport.tsx), UND als Karte im
//! Projekte-Menü (s. ProjectSettings.tsx) — wer erst in Ruhe das richtige
//! Interface sucht, muss dafür nicht auf den Sequencer-Screen wechseln.
//! Aufnahmen liegen serverseitig als WAV unter `<data_dir>/recordings/` und
//! werden über die normale HTTP-Route ausgeliefert (`main.rs`), landen hier
//! also direkt als `<audio>`-Quelle bzw. Download-Link — kein eigener Datei-
//! Server nötig, jedes Gerät im selben WLAN kann sie sich holen. Wiedergabe
//! über den 🔊-Knopf läuft dagegen über die echte Hardware des SERVERS (der
//! gewählte Ausgang), nicht über den Browser, der diese Seite gerade zeigt.
//!
//! Reihenfolge bewusst „Output → Recordings → Input": das hier ist in erster
//! Linie ein PLAYER (Ausgang wählen, Aufnahme abspielen) — wer aufnehmen will,
//! braucht den Eingang seltener und weiter unten stört das nicht.

import { useEffect, useState } from "react";
import { useNet, useSend } from "./store";
import { Popup } from "./widgets/Popup";
import { Button } from "./widgets/Button";

interface Recording {
  file: string;
  size: number;
  createdAt: number;
}

interface AudioState {
  inputs: string[];
  inputDevice: string | null;
  outputs: string[];
  outputDevice: string | null;
  playbackGain: number;
  recording: { file: string; device: string; elapsedMs: number } | null;
  playing: { file: string; device: string } | null;
  recordings: Recording[];
}

/** Ergebnis von `audio.probeInputs` für EINEN Eingang — s. `AudioRecorderPanel`. */
interface ProbeResult {
  testing: boolean;
  level?: number;
  error?: string;
}

const EMPTY: AudioState = {
  inputs: [],
  inputDevice: null,
  outputs: [],
  outputDevice: null,
  playbackGain: 2,
  recording: null,
  playing: null,
  recordings: [],
};

// Muss zu `PLAYBACK_GAIN_MIN`/`MAX` in server/src/audio.rs passen.
const GAIN_MIN = 0.25;
const GAIN_MAX = 4;
const GAIN_STEP = 0.25;
const GAIN_DEFAULT = 2;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(unixSeconds: number): string {
  if (!unixSeconds) return "unknown";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Eine Abschnitts-Karte (Output/Recordings/Input) — eigener Rahmen statt nur
 *  loser Absätze, damit die drei Blöcke auf einen Blick auseinanderfallen
 *  statt als eine große Textwand zu wirken. */
function AudioSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="audio-section">
      <div className="audio-section-head">
        <div className="audio-section-title">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Lautstärke-Regler für die Wiedergabe (`audio.setPlaybackGain`) — dieselbe
 *  −/+/Reset-Form wie „Display size" in ProjectSettings.tsx, nur mit
 *  Prozent statt Zoomfaktor. Wirkt NICHT auf den Testton — der bleibt
 *  bewusst eine feste Referenzlautstärke zum Durchprobieren des Ausgangs. */
function VolumeRow({ gain, onChange }: { gain: number; onChange: (v: number) => void }) {
  const pct = Math.round(gain * 100);
  const step = (delta: number) => onChange(Math.min(GAIN_MAX, Math.max(GAIN_MIN, gain + delta)));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
      <div style={{ flex: 1, fontSize: 14, color: "var(--pal-text-dim)" }}>Playback volume</div>
      <Button
        style={{ width: 48, height: 48, fontSize: 20 }}
        disabled={gain <= GAIN_MIN}
        onClick={() => step(-GAIN_STEP)}
      >
        −
      </Button>
      <div style={{ minWidth: 64, textAlign: "center", fontSize: 18, fontWeight: 700 }}>{pct}%</div>
      <Button
        style={{ width: 48, height: 48, fontSize: 20 }}
        disabled={gain >= GAIN_MAX}
        onClick={() => step(GAIN_STEP)}
      >
        +
      </Button>
      <Button
        style={{ height: 48, padding: "0 14px", fontSize: 15 }}
        disabled={gain === GAIN_DEFAULT}
        onClick={() => onChange(GAIN_DEFAULT)}
      >
        Reset
      </Button>
    </div>
  );
}

export function RecordingsPopup({ onClose }: { onClose: () => void }) {
  return (
    <Popup onClose={onClose} boxStyle={{ width: 640 }}>
      <AudioRecorderPanel />
    </Popup>
  );
}

export function AudioRecorderPanel() {
  const net = useNet();
  const send = useSend();
  const [audio, setAudio] = useState<AudioState>(EMPTY);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Ergebnis des letzten `audio.probeInputs`-Laufs, je Eingangsname — leer,
   *  solange keiner lief oder nach einem Geräte-Wechsel (die Liste könnte
   *  jetzt andere Einträge haben). */
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const probing = Object.values(probe).some((p) => p.testing);
  /** Rein optisch — der Server spielt den Ton unabhängig davon fest 1.2s lang
   *  (s. `audio::play_test_tone`), dieser Timer blendet den Button nur so
   *  lange als "läuft" ein. */
  const [testingTone, setTestingTone] = useState(false);
  /** Ergebnis von `audio.recordings.peek`, je Dateiname — s. "Check level"
   *  unten: sagt, ob eine unhörbare Aufnahme selbst stumm ist (dann liegt es
   *  nicht an der Wiedergabe). */
  const [peaks, setPeaks] = useState<Record<string, { loading: boolean; peak?: number; error?: string }>>({});

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "audio.state") {
        setAudio({
          inputs: evt.inputs ?? [],
          inputDevice: evt.inputDevice ?? null,
          outputs: evt.outputs ?? [],
          outputDevice: evt.outputDevice ?? null,
          playbackGain: typeof evt.playbackGain === "number" ? evt.playbackGain : GAIN_DEFAULT,
          recording: evt.recording ?? null,
          playing: evt.playing ?? null,
          recordings: evt.recordings ?? [],
        });
        setError(null);
      } else if (evt.t === "audio.recordings") {
        setAudio((a) => ({ ...a, recordings: evt.recordings ?? [] }));
      } else if (evt.t === "audio.playbackDone") {
        // Server clears its side lazily (next play/stop) — clear the UI's
        // "currently playing" indicator right away instead of waiting for
        // another audio.state round trip.
        setAudio((a) => (a.playing?.file === evt.file ? { ...a, playing: null } : a));
      } else if (evt.t === "audio.error") {
        setError(typeof evt.message === "string" ? evt.message : "Recording failed");
      } else if (evt.t === "audio.probeStart") {
        setProbe((p) => ({ ...p, [evt.device]: { testing: true } }));
      } else if (evt.t === "audio.probeResult") {
        setProbe((p) => ({
          ...p,
          [evt.device]: { testing: false, level: evt.level, error: evt.error },
        }));
      } else if (evt.t === "audio.recordingPeak") {
        setPeaks((p) => ({ ...p, [evt.file]: { loading: false, peak: evt.peak, error: evt.error } }));
      }
    });
    send({ t: "audio.getState" });
    return off;
  }, [net, send]);

  const httpBase = net.httpBase();
  const fileUrl = (file: string) => `${httpBase}/recordings/${encodeURIComponent(file)}`;

  return (
    <div className="audio-panel">
      <div className="popup-title">Audio player</div>
      <div className="popup-subtitle">
        Choose an output below to play recordings through the Pi's own speakers/interface, then use
        ▶/🔊 on a recording. Record new takes from the ⏺ button in the transport bar (input below).
      </div>

      {error && <div style={{ color: "var(--pal-danger)", fontSize: 15, marginBottom: 14 }}>{error}</div>}

      <AudioSection
        title="Output"
        action={
          <Button
            style={{ height: 56, padding: "0 18px", fontSize: 17 }}
            disabled={testingTone || audio.outputs.length === 0}
            onClick={() => {
              setTestingTone(true);
              send({ t: "audio.testOutput" });
              window.setTimeout(() => setTestingTone(false), 1300);
            }}
          >
            {testingTone ? "Playing…" : "🔔 Test tone"}
          </Button>
        }
      >
        <div className="popup-subtitle">
          Nothing audible when you press ▶/🔊 below? Tap “Test tone” — it plays a short beep
          straight out of the selected output, no recording involved. If you don't hear that
          either, the recording isn't the problem — check the output device, cabling, or volume.
        </div>
        {audio.outputs.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: 16 }}>No audio output found</div>
        ) : (
          audio.outputs.map((name) => {
            const active = audio.outputDevice ? audio.outputDevice === name : name === audio.outputs[0];
            return (
              <Button
                key={name}
                variant={active ? "active" : "default"}
                className="popup-row"
                onClick={() => send({ t: "audio.setOutput", device: name })}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              </Button>
            );
          })
        )}
        <VolumeRow gain={audio.playbackGain} onChange={(v) => send({ t: "audio.setPlaybackGain", gain: v })} />
      </AudioSection>

      <AudioSection title="Recordings">
        <div className="popup-subtitle">
          Reachable from any device on this Wi-Fi at {httpBase}/recordings/&lt;file&gt;
        </div>
        {audio.recordings.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: 16 }}>Nothing recorded yet</div>
        ) : (
          audio.recordings.map((r) =>
            pendingDelete === r.file ? (
              <div key={r.file} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1, fontSize: 16, color: "var(--pal-text-dim)" }}>Delete “{r.file}”?</div>
                <Button
                  variant="danger"
                  style={{ height: 52, padding: "0 18px", fontSize: 16 }}
                  onClick={() => {
                    send({ t: "audio.recordings.delete", file: r.file });
                    setPendingDelete(null);
                  }}
                >
                  Delete
                </Button>
                <Button style={{ height: 52, padding: "0 18px", fontSize: 16 }} onClick={() => setPendingDelete(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div key={r.file} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 17,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.file}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--pal-text-dim)" }}>
                      {formatBytes(r.size)} · {formatAge(r.createdAt)}
                      {peaks[r.file] &&
                        (peaks[r.file].loading ? (
                          <> · checking…</>
                        ) : peaks[r.file].error ? (
                          <>
                            {" · "}
                            <span style={{ color: "var(--pal-danger)" }}>⚠ {peaks[r.file].error}</span>
                          </>
                        ) : (
                          <>
                            {" · peak "}
                            <span
                              style={{
                                color: (peaks[r.file].peak ?? 0) < 0.02 ? "var(--pal-danger)" : "var(--pal-text-dim)",
                                fontWeight: (peaks[r.file].peak ?? 0) < 0.02 ? 700 : 400,
                              }}
                            >
                              {(peaks[r.file].peak ?? 0) < 0.02
                                ? "near-silent"
                                : `${Math.round((peaks[r.file].peak ?? 0) * 100)}%`}
                            </span>
                          </>
                        ))}
                    </div>
                  </div>
                  <Button
                    style={{ width: 64, height: 64, fontSize: 22 }}
                    disabled={peaks[r.file]?.loading}
                    title="Check whether this file actually has audio in it (no speakers needed)"
                    onClick={() => {
                      setPeaks((p) => ({ ...p, [r.file]: { loading: true } }));
                      send({ t: "audio.recordings.peek", file: r.file });
                    }}
                  >
                    📊
                  </Button>
                  <Button
                    variant={audio.playing?.file === r.file ? "active" : "default"}
                    style={{ width: 64, height: 64, fontSize: 24 }}
                    title={
                      audio.playing?.file === r.file
                        ? "Stop playback on the Pi"
                        : "Play through the Pi's audio output"
                    }
                    onClick={() =>
                      send(
                        audio.playing?.file === r.file
                          ? { t: "audio.play.stop" }
                          : { t: "audio.play.start", file: r.file },
                      )
                    }
                  >
                    {audio.playing?.file === r.file ? "■" : "🔊"}
                  </Button>
                  <a
                    className="btn"
                    style={{
                      width: 64,
                      height: 64,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 22,
                      textDecoration: "none",
                    }}
                    href={fileUrl(r.file)}
                    download={r.file}
                    title="Download"
                  >
                    ↓
                  </a>
                  <Button
                    variant="danger"
                    style={{ width: 64, height: 64, fontSize: 24 }}
                    onClick={() => setPendingDelete(r.file)}
                  >
                    ✕
                  </Button>
                </div>
                <audio src={fileUrl(r.file)} controls preload="none" style={{ width: "100%", marginTop: 8, height: 40 }} />
              </div>
            ),
          )
        )}
      </AudioSection>

      <AudioSection
        title="Input"
        action={
          <Button
            style={{ height: 56, padding: "0 18px", fontSize: 17 }}
            disabled={probing || audio.inputs.length === 0}
            onClick={() => {
              setProbe({});
              send({ t: "audio.probeInputs" });
            }}
          >
            {probing ? "Testing…" : "Test inputs"}
          </Button>
        }
      >
        <div className="popup-subtitle">
          Same name listed more than once? Tap “Test inputs” and speak into the mic — the bar
          moves on the one that's actually live.
        </div>
        {audio.inputs.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: 16 }}>No audio input found</div>
        ) : (
          audio.inputs.map((name) => {
            // Kein gewählter Eingang → der Server nimmt den System-Standard,
            // hier als "aktiv" markiert, damit die Liste nie ganz leer aussieht.
            const active = audio.inputDevice ? audio.inputDevice === name : name === audio.inputs[0];
            const result = probe[name];
            return (
              <Button
                key={name}
                variant={active ? "active" : "default"}
                className="popup-row"
                style={{ flexDirection: "column", alignItems: "stretch", height: "auto", padding: "10px 16px" }}
                onClick={() => send({ t: "audio.setInput", device: name })}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                {result && (
                  <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    {result.testing ? (
                      <span style={{ fontSize: 13, color: "var(--pal-text-dim)" }}>listening…</span>
                    ) : result.error ? (
                      <span style={{ fontSize: 13, color: "var(--pal-danger)" }}>⚠ {result.error}</span>
                    ) : (
                      <span
                        style={{
                          flex: 1,
                          height: 9,
                          borderRadius: 4,
                          background: "rgba(255,255,255,0.12)",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${Math.round(Math.min(1, result.level ?? 0) * 100)}%`,
                            background: "var(--pal-run)",
                            transition: "width 120ms linear",
                          }}
                        />
                      </span>
                    )}
                  </span>
                )}
              </Button>
            );
          })
        )}
      </AudioSection>
    </div>
  );
}
