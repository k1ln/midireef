//! Interface-Auswahl + Aufnahmen-Verwaltung. Der eigentliche Inhalt
//! (`AudioRecorderPanel`) lebt an zwei Stellen: als Popup, geöffnet über
//! langes Halten des Aufnahme-Knopfs in der Transport-Leiste (s.
//! Transport.tsx), UND als Karte im Projekte-Menü (s. ProjectSettings.tsx) —
//! wer erst in Ruhe das richtige Interface sucht, muss dafür nicht auf den
//! Sequencer-Screen wechseln. Aufnahmen liegen serverseitig als WAV unter
//! `<data_dir>/recordings/` und werden über die normale HTTP-Route
//! ausgeliefert (`main.rs`), landen hier also direkt als `<audio>`-Quelle
//! bzw. Download-Link — kein eigener Datei-Server nötig, jedes Gerät im
//! selben WLAN kann sie sich holen.

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
  recording: { file: string; device: string; elapsedMs: number } | null;
  recordings: Recording[];
}

/** Ergebnis von `audio.probeInputs` für EINEN Eingang — s. `AudioRecorderPanel`. */
interface ProbeResult {
  testing: boolean;
  level?: number;
  error?: string;
}

const EMPTY: AudioState = { inputs: [], inputDevice: null, recording: null, recordings: [] };

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

export function RecordingsPopup({ onClose }: { onClose: () => void }) {
  return (
    <Popup onClose={onClose} boxStyle={{ width: 460 }}>
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

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if (evt.t === "audio.state") {
        setAudio({
          inputs: evt.inputs ?? [],
          inputDevice: evt.inputDevice ?? null,
          recording: evt.recording ?? null,
          recordings: evt.recordings ?? [],
        });
        setError(null);
      } else if (evt.t === "audio.recordings") {
        setAudio((a) => ({ ...a, recordings: evt.recordings ?? [] }));
      } else if (evt.t === "audio.error") {
        setError(typeof evt.message === "string" ? evt.message : "Recording failed");
      } else if (evt.t === "audio.probeStart") {
        setProbe((p) => ({ ...p, [evt.device]: { testing: true } }));
      } else if (evt.t === "audio.probeResult") {
        setProbe((p) => ({
          ...p,
          [evt.device]: { testing: false, level: evt.level, error: evt.error },
        }));
      }
    });
    send({ t: "audio.getState" });
    return off;
  }, [net, send]);

  const httpBase = net.httpBase();
  const fileUrl = (file: string) => `${httpBase}/recordings/${encodeURIComponent(file)}`;

  return (
    <>
      <div className="popup-title">Audio recorder</div>
      <div className="popup-subtitle">
        Choose the input interface below, then record from the ⏺ button in the transport bar.
      </div>

      {error && (
        <div style={{ color: "var(--pal-danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 12, color: "var(--pal-text-dim)" }}>Input interface</div>
          <Button
            style={{ height: 32, padding: "0 12px", fontSize: 12 }}
            disabled={probing || audio.inputs.length === 0}
            onClick={() => {
              setProbe({});
              send({ t: "audio.probeInputs" });
            }}
          >
            {probing ? "Testing…" : "Test inputs"}
          </Button>
        </div>
        <div className="popup-subtitle" style={{ marginTop: -2 }}>
          Same name listed more than once? Tap “Test inputs” and speak into the mic — the bar
          moves on the one that's actually live.
        </div>
        {audio.inputs.length === 0 ? (
          <div style={{ color: "var(--pal-text-dim)", fontSize: 14 }}>No audio input found</div>
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
                style={{ flexDirection: "column", alignItems: "stretch", height: "auto", padding: "6px 12px" }}
                onClick={() => send({ t: "audio.setInput", device: name })}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                {result && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    {result.testing ? (
                      <span style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>listening…</span>
                    ) : result.error ? (
                      <span style={{ fontSize: 11, color: "var(--pal-danger)" }}>⚠ {result.error}</span>
                    ) : (
                      <span
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 3,
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
      </div>

      <div style={{ fontSize: 12, color: "var(--pal-text-dim)", marginBottom: 6 }}>
        Recordings — reachable from any device on this Wi-Fi at {httpBase}/recordings/&lt;file&gt;
      </div>
      {audio.recordings.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 14 }}>Nothing recorded yet</div>
      ) : (
        audio.recordings.map((r) =>
          pendingDelete === r.file ? (
            <div key={r.file} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1, fontSize: 14, color: "var(--pal-text-dim)" }}>Delete “{r.file}”?</div>
              <Button
                variant="danger"
                style={{ height: 44, padding: "0 14px" }}
                onClick={() => {
                  send({ t: "audio.recordings.delete", file: r.file });
                  setPendingDelete(null);
                }}
              >
                Delete
              </Button>
              <Button style={{ height: 44, padding: "0 14px" }} onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div key={r.file} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.file}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
                    {formatBytes(r.size)} · {formatAge(r.createdAt)}
                  </div>
                </div>
                <a
                  className="btn"
                  style={{
                    width: 44,
                    height: 44,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 18,
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
                  style={{ width: 44, height: 44, fontSize: 16 }}
                  onClick={() => setPendingDelete(r.file)}
                >
                  ✕
                </Button>
              </div>
              <audio src={fileUrl(r.file)} controls preload="none" style={{ width: "100%", marginTop: 6, height: 34 }} />
            </div>
          ),
        )
      )}
    </>
  );
}
