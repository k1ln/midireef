//! Song / Arrangement — Scenes zu einem Track verketten (architecture doc
//! §4c/§5.6). Jeder Step spielt `sceneId` für `bars` Takte, dann rückt der
//! Server (Clock-Thread, `SongPlayback` in server/src/clock.rs) automatisch
//! zum nächsten Step vor — inkl. optionaler Tempo-/Taktart-Automation pro
//! Step. Die UI schickt nur `song.play`/`song.stop`; die Fortschaltung selbst
//! läuft komplett serverseitig, weil nur der Clock-Thread den Puls-Zähler
//! kennt (Taktgrenzen).
//!
//! `transport.songMode`/`activeSongId`/`activeSongStepIndex`/`songBarsRemaining`
//! kommen wie in Transport.tsx über eine eigene `net.onEvent`-Subscription,
//! NICHT über den Store: `Store.setTransport` löst bewusst kein Re-Render aus
//! (die Ticks sind zu häufig) — hier reicht das, weil Song-Fortschritt sich
//! nur einmal pro Takt ändert, nicht 30-60×/s.

import { useEffect, useState, type CSSProperties } from "react";
import type { Scene, Song, SongStep } from "../state";
import type { TransportState } from "../net";
import { useNet, useSend, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { Button } from "./widgets/Button";
import { Popup } from "./widgets/Popup";

const EMPTY_SONGS: Song[] = [];
const EMPTY_SCENES: Scene[] = [];

type Send = ReturnType<typeof useSend>;

export function Songs() {
  const send = useSend();
  const net = useNet();
  const openKeyboard = useTouchKeyboard();
  const songs = useStoreValue((s) => (s.project?.songs as Song[] | undefined) ?? EMPTY_SONGS);
  const scenes = useStoreValue((s) => (s.project?.scenes as Scene[] | undefined) ?? EMPTY_SCENES);
  const [transport, setTransport] = useState<TransportState | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [stepPickerFor, setStepPickerFor] = useState<string | null>(null);
  const [overridesFor, setOverridesFor] = useState<{ songId: string; index: number } | null>(null);

  useEffect(() => {
    const off = net.onEvent((evt) => {
      if ((evt.t === "transport.tick" || evt.t === "state.snapshot") && evt.transport) {
        setTransport(evt.transport);
      }
    });
    return off;
  }, [net]);

  const sceneName = (id: string) => scenes.find((s) => s.id === id)?.name ?? "?";

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginBottom: 16 }}>
        Chain scenes into a timeline — each step plays for N bars, then the server auto-advances to the next one.
      </div>

      <Button
        style={{ width: "100%", height: 50, fontSize: 16, marginBottom: 16 }}
        onClick={() => openKeyboard("", 24, (v) => v && send({ t: "song.create", name: v }))}
      >
        + New song
      </Button>

      {songs.length === 0 && <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>No songs yet.</div>}

      {songs.map((song) => {
        const isPlaying = !!transport?.songMode && transport.activeSongId === song.id;
        return (
          <div key={song.id} className="settings-card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button
                variant={isPlaying ? "active" : undefined}
                style={{ flex: 1, height: 54, fontSize: 17, fontWeight: 700 }}
                disabled={song.steps.length === 0}
                onClick={() => (isPlaying ? send({ t: "song.stop" }) : send({ t: "song.play", songId: song.id }))}
              >
                {isPlaying ? "■ Stop" : "▶"} {song.name}
              </Button>
              <Button
                style={{ width: 64, height: 54, fontSize: 13 }}
                onClick={() => setExpanded(expanded === song.id ? null : song.id)}
              >
                {expanded === song.id ? "Close" : "Edit"}
              </Button>
            </div>

            {isPlaying && (
              <div style={{ fontSize: 13, color: "var(--pal-text-dim)", marginTop: 8 }}>
                Step {(transport?.activeSongStepIndex ?? 0) + 1}/{song.steps.length}
                {transport?.songBarsRemaining != null ? ` · ${transport.songBarsRemaining} bar(s) left` : ""}
              </div>
            )}

            {expanded === song.id && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div style={{ flex: 1, fontSize: 14 }}>Name</div>
                  <Button
                    style={{ height: 40, padding: "0 14px", fontSize: 14 }}
                    onClick={() =>
                      openKeyboard(song.name, 24, (v) => v != null && send({ t: "song.update", song: { ...song, name: v } }))
                    }
                  >
                    {song.name}
                  </Button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <div style={{ flex: 1, fontSize: 14 }}>Loop</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {([true, false] as boolean[]).map((on) => (
                      <Button
                        key={String(on)}
                        variant={song.loop === on ? (on ? "active" : undefined) : "alt"}
                        style={{ width: 60, height: 36, fontSize: 13 }}
                        onClick={() => send({ t: "song.update", song: { ...song, loop: on } })}
                      >
                        {on ? "On" : "Off"}
                      </Button>
                    ))}
                  </div>
                </div>

                {song.steps.length === 0 && (
                  <div style={{ color: "var(--pal-text-dim)", fontSize: 13, marginBottom: 10 }}>
                    No steps yet — add one below.
                  </div>
                )}

                {song.steps.map((step, i) => {
                  const active = isPlaying && transport?.activeSongStepIndex === i;
                  return (
                    <div
                      key={step.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        background: active ? "var(--pal-btn)" : "var(--pal-panel-deep)",
                        border: active ? "1px solid var(--pal-btn-active, rgba(255,255,255,0.4))" : "1px solid transparent",
                        borderRadius: 8,
                        padding: "8px 10px",
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={i === 0}
                          style={reorderBtn(i === 0)}
                          onClick={() => moveStep(song, i, -1, send)}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={i === song.steps.length - 1}
                          style={reorderBtn(i === song.steps.length - 1)}
                          onClick={() => moveStep(song, i, 1, send)}
                        >
                          ▼
                        </button>
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {i + 1}. {sceneName(step.sceneId)}
                        </div>
                        {(step.bpmOverride != null || step.timeSignatureOverride != null) && (
                          <div style={{ fontSize: 11, color: "var(--pal-text-dim)" }}>
                            {step.bpmOverride != null ? `${step.bpmOverride} BPM` : ""}
                            {step.bpmOverride != null && step.timeSignatureOverride != null ? " · " : ""}
                            {step.timeSignatureOverride ?? ""}
                          </div>
                        )}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          type="button"
                          aria-label="Fewer bars"
                          style={stepperBtn}
                          onClick={() => updateStep(song, i, { bars: Math.max(1, step.bars - 1) }, send)}
                        >
                          −
                        </button>
                        <span style={{ fontSize: 13, fontWeight: 700, width: 46, textAlign: "center" }}>
                          {step.bars} bar{step.bars === 1 ? "" : "s"}
                        </span>
                        <button
                          type="button"
                          aria-label="More bars"
                          style={stepperBtn}
                          onClick={() => updateStep(song, i, { bars: Math.min(64, step.bars + 1) }, send)}
                        >
                          +
                        </button>
                      </div>

                      <button
                        type="button"
                        aria-label="Tempo / time signature automation"
                        style={{ ...stepperBtn, fontSize: 13 }}
                        onClick={() => setOverridesFor({ songId: song.id, index: i })}
                      >
                        ⚙
                      </button>

                      <button
                        type="button"
                        aria-label="Remove step"
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: "50%",
                          border: "none",
                          background: "var(--pal-danger)",
                          color: "var(--pal-white)",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          send({ t: "song.update", song: { ...song, steps: song.steps.filter((_, j) => j !== i) } })
                        }
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                <Button
                  style={{ width: "100%", height: 42, fontSize: 14, marginTop: 4 }}
                  onClick={() => setStepPickerFor(song.id)}
                >
                  + Add step
                </Button>

                {confirmingDelete === song.id ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Button
                      variant="danger"
                      style={{ flex: 1, height: 42 }}
                      onClick={() => {
                        setConfirmingDelete(null);
                        setExpanded(null);
                        send({ t: "song.delete", songId: song.id });
                      }}
                    >
                      Confirm delete
                    </Button>
                    <Button style={{ flex: 1, height: 42 }} onClick={() => setConfirmingDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="danger"
                    style={{ width: "100%", height: 42, fontSize: 14, marginTop: 12 }}
                    onClick={() => setConfirmingDelete(song.id)}
                  >
                    Delete song
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {stepPickerFor &&
        (() => {
          const song = songs.find((s) => s.id === stepPickerFor);
          return song ? <AddSongStepPopup song={song} scenes={scenes} onClose={() => setStepPickerFor(null)} /> : null;
        })()}

      {overridesFor &&
        (() => {
          const song = songs.find((s) => s.id === overridesFor.songId);
          return song && song.steps[overridesFor.index] ? (
            <StepOverridesPopup song={song} index={overridesFor.index} onClose={() => setOverridesFor(null)} />
          ) : null;
        })()}
    </div>
  );
}

function moveStep(song: Song, index: number, dir: -1 | 1, send: Send) {
  const target = index + dir;
  if (target < 0 || target >= song.steps.length) return;
  const steps = [...song.steps];
  [steps[index], steps[target]] = [steps[target], steps[index]];
  send({ t: "song.update", song: { ...song, steps } });
}

function updateStep(song: Song, index: number, patch: Partial<SongStep>, send: Send) {
  const steps = song.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
  send({ t: "song.update", song: { ...song, steps } });
}

/** Scene für einen neuen Step wählen (Bars startet bei 4, danach per Stepper
 *  in der Step-Zeile anpassbar). */
function AddSongStepPopup({ song, scenes, onClose }: { song: Song; scenes: Scene[]; onClose: () => void }) {
  const send = useSend();
  const addStep = (sceneId: string) => {
    onClose();
    const step: SongStep = { id: crypto.randomUUID(), sceneId, bars: 4 };
    send({ t: "song.update", song: { ...song, steps: [...song.steps, step] } });
  };
  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Add step — {song.name}</div>
      {scenes.length === 0 ? (
        <div style={{ color: "var(--pal-text-dim)", fontSize: 15 }}>
          No scenes yet — create one on the Scenes tab first.
        </div>
      ) : (
        scenes.map((scene) => (
          <Button key={scene.id} className="popup-row" onClick={() => addStep(scene.id)}>
            {scene.name}
          </Button>
        ))
      )}
    </Popup>
  );
}

/** Optionale Tempo-/Taktart-Automation für EINEN Step — leer heißt: der
 *  vorige Stand (Projekt-Default bzw. letzter Step-Override) läuft weiter. */
function StepOverridesPopup({ song, index, onClose }: { song: Song; index: number; onClose: () => void }) {
  const send = useSend();
  const openKeyboard = useTouchKeyboard();
  const step = song.steps[index];

  const apply = (patch: Partial<SongStep>) => {
    const steps = song.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    send({ t: "song.update", song: { ...song, steps } });
  };

  return (
    <Popup onClose={onClose}>
      <div className="popup-title">Step {index + 1} automation</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 14 }}>Tempo override</div>
        <button type="button" style={stepperBtn} onClick={() => apply({ bpmOverride: Math.max(20, (step.bpmOverride ?? 121) - 1) })}>
          −
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, width: 60, textAlign: "center" }}>
          {step.bpmOverride ?? "—"}
        </span>
        <button type="button" style={stepperBtn} onClick={() => apply({ bpmOverride: Math.min(300, (step.bpmOverride ?? 119) + 1) })}>
          +
        </button>
      </div>
      {step.bpmOverride != null && (
        <Button variant="danger" className="popup-row" style={{ marginBottom: 16, height: 38 }} onClick={() => apply({ bpmOverride: undefined })}>
          Clear tempo override
        </Button>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 14 }}>Time signature override</div>
        <Button
          style={{ height: 40, padding: "0 14px", fontSize: 14 }}
          onClick={() => openKeyboard(step.timeSignatureOverride ?? "4/4", 5, (v) => v && apply({ timeSignatureOverride: v }))}
        >
          {step.timeSignatureOverride ?? "—"}
        </Button>
      </div>
      {step.timeSignatureOverride != null && (
        <Button variant="danger" className="popup-row" style={{ height: 38 }} onClick={() => apply({ timeSignatureOverride: undefined })}>
          Clear time signature override
        </Button>
      )}
    </Popup>
  );
}

function reorderBtn(disabled: boolean): CSSProperties {
  return {
    width: 22,
    height: 20,
    border: "none",
    borderRadius: 4,
    background: disabled ? "transparent" : "var(--pal-btn-alt)",
    color: disabled ? "var(--pal-text-dim)" : "var(--pal-text)",
    fontSize: 10,
    cursor: disabled ? "default" : "pointer",
  };
}

const stepperBtn: CSSProperties = {
  width: 28,
  height: 28,
  border: "none",
  borderRadius: "50%",
  background: "var(--pal-btn-alt)",
  color: "var(--pal-text)",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};
