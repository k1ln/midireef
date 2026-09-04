//! Dashboard (Home) — React-Port von ui/mainscreen.ts. Zeigt gelernte Taster
//! (Note) und Drehregler (CC), live bedienbar.
//!
//!  - Taster antippen → Note-On/Off. Drehregler vertikal ziehen → CC-Wert.
//!  - Rechtsklick / Zwei-Finger (ein Finger auf Control + zweiter tippt) →
//!    Kontextmenü mit „Move", „Device …", „Remove".
//!  - Ein Finger auf freier Fläche ziehen → Dashboard verschieben (Pan).
//!  - Mausrad → Pan; Strg/⌘+Mausrad oder Zwei-Finger-Pinch → Zoom.
//!  - „Center"-Button setzt Pan/Zoom zurück. Langer Druck auf freie Fläche →
//!    MIDI-Learn.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useNet, useSend, useStore, useStoreValue } from "./store";
import { useTouchKeyboard } from "./TouchKeyboard";
import { useViewportSize } from "./useViewportSize";
import { Button } from "./widgets/Button";
import { ControlWidget, type LiveControl } from "./dashboard/ControlWidget";
import { DevicePickerPopup, KindPickerPopup, LanePickerPopup, TriggerPickerPopup } from "./dashboard/menus";
import type { Block } from "../state";
import { ControlDock, CONTROL_DOCK_W } from "./dashboard/ControlDock";
import type { Device } from "../state";

const TOP = 100;
const LONG_PRESS_MS = 700;
// Breite des rechts angedockten Control-Menüs — nur noch für die Anker der
// Geräte-/Lane-Picker (das Dock überlagert, es rückt nichts ein).
const DOCK_W = CONTROL_DOCK_W;

// Stable references so the useSyncExternalStore selector below returns the
// same identity across calls when there's no project yet — a fresh `[]`
// each call would never satisfy Object.is and spin React into an infinite
// update loop.
const EMPTY_DEVICES: Device[] = [];
const EMPTY_CONTROLS: LiveControl[] = [];
const EMPTY_BLOCKS: Block[] = [];

interface Pt {
  x: number;
  y: number;
}
function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function clampZoom(z: number): number {
  return Math.min(2, Math.max(0.3, z));
}

export function Dashboard({ centerSignal }: { centerSignal?: number }) {
  const send = useSend();
  const net = useNet();
  const store = useStore();
  const openKeyboard = useTouchKeyboard();
  const { w, h } = useViewportSize();
  const devices = useStoreValue((s) => s.project?.devices ?? EMPTY_DEVICES);
  const controls = useStoreValue((s) => (s.project?.controls as LiveControl[] | undefined) ?? EMPTY_CONTROLS);
  const blocks = useStoreValue((s) => (s.project?.blocks as Block[] | undefined) ?? EMPTY_BLOCKS);
  const recordArmed = useStoreValue((s) => s.recordArmed);

  const [armed, setArmed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [devicePicker, setDevicePicker] = useState<{ ctrl: LiveControl } | null>(null);
  const [lanePicker, setLanePicker] = useState<{ ctrl: LiveControl } | null>(null);
  const [triggerPicker, setTriggerPicker] = useState<{ ctrl: LiveControl } | null>(null);
  const [kindPicker, setKindPicker] = useState<{ controlId: string; mappingKind: "cc" | "note" } | null>(null);
  // Controls currently "on" because the physical device sent a matching
  // Note-On (not persisted project state — purely a live UI light-up, mirrors
  // what a hardware pad's own LED would do).
  const [physicallyActive, setPhysicallyActive] = useState<Set<string>>(new Set());

  const pointers = useRef(new Map<number, Pt>());
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const isPanning = useRef(false);
  const pinch = useRef<{ startDist: number; startZoom: number } | null>(null);
  const pressedControl = useRef<LiveControl | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  const cancelPress = () => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
  };

  const showError = (message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  const promptName = (controlId: string) => {
    openKeyboard("", 24, (v) => {
      if (v) send({ t: "control.assignName", controlId, name: v });
      // Cancelled (or submitted empty) — don't leave a nameless stray
      // control behind; the server already created it when the MIDI
      // message was captured, before this prompt ever opened.
      else send({ t: "control.delete", controlId });
    });
  };

  useEffect(() => {
    const off = net.onEvent((evt) => {
      switch (evt.t) {
        case "learn.armed":
          setArmed(!!evt.armed);
          break;
        case "learn.captured":
          if (evt.controlId) {
            setArmed(false);
            // CC ist mehrdeutig: mancher Controller sendet für Taster (z.B.
            // „Play") ebenfalls CC statt Note — Nutzer entscheidet, wie
            // reproduziert wird. Note ist ebenso mehrdeutig: eine einzelne
            // gelernte Taste oder Stellvertreter für ein ganzes Keyboard?
            if (evt.mapping?.kind === "cc" || evt.mapping?.kind === "note") {
              setKindPicker({ controlId: evt.controlId, mappingKind: evt.mapping.kind });
            } else {
              promptName(evt.controlId);
            }
          }
          break;
        case "control.sendError":
          if (evt.message) showError(evt.message);
          break;
        // Physisch am Gerät bedientes, gelerntes Control — Dashboard live
        // nachführen (Gegenstück zu den obigen einmaligen Learn-Events).
        case "control.valueChanged":
          if (evt.controlId) store.patchControl(evt.controlId, { value: evt.value });
          break;
        case "control.activity":
          if (evt.controlId) {
            setPhysicallyActive((prev) => {
              const next = new Set(prev);
              if (evt.active) next.add(evt.controlId);
              else next.delete(evt.controlId);
              return next;
            });
          }
          break;
      }
    });
    return off;
  }, [net, store]);

  const selectControl = (ctrl: LiveControl) => {
    // Stuck-note safety net: if this control has a note currently held,
    // release it before the dock takes over the gesture.
    if (ctrl.kind === "button" || ctrl.mapping?.kind === "note") {
      send({ t: "control.release", controlId: ctrl.id });
    }
    setSelectedId(ctrl.id);
  };

  // ── Hintergrund-Gesten (Pan, MIDI-Learn, Zwei-Finger, Pinch) ───────────────

  const onBgPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelPress();
    // A finger already down on a control never reaches `pointers` (its own
    // pointerdown handler stops propagation so it doesn't start a pan/learn
    // gesture here) — so `pressedControl` is the only signal that finger
    // exists. Without it in this condition, `pointers.current.size` could
    // never reach 2 from a control+background combo, only from two fingers
    // both landing on empty background (pinch) — the knob's context menu
    // would then be unreachable by touch.
    if (pointers.current.size >= 2 || pressedControl.current) {
      panStart.current = null;
      isPanning.current = false;
      if (pressedControl.current) {
        selectControl(pressedControl.current);
      } else {
        const pts = [...pointers.current.values()];
        pinch.current = { startDist: dist(pts[0], pts[1]), startZoom: zoom };
      }
      return;
    }
    if (!editMode) {
      // Tipp auf freie Fläche schließt das Control-Dock wieder.
      setSelectedId(null);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      if (!armed) {
        pressTimer.current = window.setTimeout(() => send({ t: "learn.start" }), LONG_PRESS_MS);
      }
    }
  };

  const onBgPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const pts = [...pointers.current.values()];
      const d = dist(pts[0], pts[1]);
      if (pinch.current.startDist > 0) setZoom(clampZoom(pinch.current.startZoom * (d / pinch.current.startDist)));
      return;
    }
    // Einzelner Finger auf freier Fläche gezogen → Dashboard verschieben.
    // Erst ab einer kleinen Schwelle, damit ein Tap für den Lang-Druck
    // (Learn) nicht sofort als Pan erkannt wird.
    if (panStart.current && pointers.current.size === 1) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      if (!isPanning.current && Math.hypot(dx, dy) > 8) {
        isPanning.current = true;
        cancelPress();
      }
      if (isPanning.current) setPan({ x: panStart.current.panX + dx, y: panStart.current.panY + dy });
    }
  };

  const onBgPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    cancelPress();
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) {
      panStart.current = null;
      isPanning.current = false;
    }
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) setZoom((z) => clampZoom(z * (1 - e.deltaY * 0.001)));
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // „Center" sitzt jetzt in der Transport-Leiste (App zählt `centerSignal`
  // hoch) — hier nur die Reaktion, den ersten Wert überspringen.
  const centerSeen = useRef(centerSignal);
  useEffect(() => {
    if (centerSignal === centerSeen.current) return;
    centerSeen.current = centerSignal;
    resetView();
  }, [centerSignal]);

  const cx = w / 2;
  const cy = (TOP + h) / 2;

  const selectedCtrl = selectedId ? controls.find((c) => c.id === selectedId) : undefined;
  const triggerLabelFor = (ctrl: LiveControl): string | undefined => {
    if (!ctrl.trigger) return undefined;
    for (const d of devices) {
      const l = d.lanes.find((x) => x.id === ctrl.trigger!.laneId);
      if (l && l.slots.some((s) => s.id === ctrl.trigger!.slotId)) return `Trigger: ${l.name}`;
    }
    return "Trigger: (gone)";
  };
  // Auswahl zeigt ins Leere (Control gelöscht) → aufräumen.
  useEffect(() => {
    if (selectedId && !controls.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [selectedId, controls]);

  const deviceName = (deviceId?: string | null) => devices.find((d) => d.id === deviceId)?.name;

  return (
    // Fragment, not a `position: fixed; inset: 0` div — every child below
    // already positions itself via `fixed`, and a full-viewport wrapper
    // here would paint over (and swallow clicks on) the Transport bar at
    // the top of the screen, since this renders after <Transport> in App.
    <>
      <div
        style={{
          position: "fixed",
          top: TOP,
          left: 0,
          // Das Dock überlagert nur (kein Einrücken) — bei Tipp-zum-Auswählen
          // würde ein Layout-Sprung bei jedem Pad-Antippen stören. Verdeckte
          // Controls erreicht man durch Verschieben (Pan).
          right: 0,
          bottom: 0,
          overflow: "hidden",
          touchAction: "none",
        }}
        onPointerDown={onBgPointerDown}
        onPointerMove={onBgPointerMove}
        onPointerUp={onBgPointerUp}
        onPointerCancel={onBgPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "0 0",
            transform: `translate(${cx * (1 - zoom) + pan.x}px, ${cy * (1 - zoom) + pan.y}px) scale(${zoom})`,
          }}
        >
          {controls.length === 0 && (
            <div style={{ position: "absolute", left: 16, top: 8, fontSize: 18, color: "var(--pal-text-dim)", fontWeight: 600 }}>
              Long-press an empty area to learn a MIDI control.
            </div>
          )}

          {controls.map((ctrl) => (
            <ControlWidget
              key={ctrl.id}
              ctrl={ctrl}
              deviceName={deviceName(ctrl.deviceId)}
              editMode={editMode}
              zoom={zoom}
              selected={ctrl.id === selectedId}
              externalActive={physicallyActive.has(ctrl.id)}
              recording={recordArmed?.controlId === ctrl.id}
              onSelect={() => setSelectedId(ctrl.id)}
              onContextMenu={() => selectControl(ctrl)}
              onPress={() => (pressedControl.current = ctrl)}
              onRelease={() => {
                if (pressedControl.current?.id === ctrl.id) pressedControl.current = null;
              }}
            />
          ))}
        </div>
      </div>

      {editMode && (
        <div style={{ position: "fixed", top: TOP + 12, left: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Move mode: drag controls</div>
          <Button variant="active" style={{ width: 120, height: 44, fontSize: 18 }} onClick={() => setEditMode(false)}>
            Done
          </Button>
        </div>
      )}

      {armed && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 15,
          }}
          onClick={() => {
            setArmed(false);
            send({ t: "learn.cancel" });
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 700, color: "var(--pal-white)" }}>MIDI Learn active</div>
          <div style={{ fontSize: 20, color: "var(--pal-text-dim)", marginTop: 12 }}>
            Now move a button/knob on the MIDI device …  (tap to cancel)
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 560,
            padding: "0 20px",
            height: 64,
            display: "flex",
            alignItems: "center",
            borderRadius: 10,
            background: "rgba(17, 17, 17, 0.97)",
            border: "1.5px solid rgba(255, 255, 255, 0.4)",
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {toast}
        </div>
      )}

      {selectedCtrl && (
        <ControlDock
          ctrl={selectedCtrl}
          deviceName={deviceName(selectedCtrl.deviceId)}
          isRecording={recordArmed?.controlId === selectedCtrl.id}
          onClose={() => setSelectedId(null)}
          onRename={(name) => send({ t: "control.assignName", controlId: selectedCtrl.id, name })}
          onSetSize={(px) => send({ t: "control.setSize", controlId: selectedCtrl.id, w: px, h: px })}
          onMove={() => {
            setSelectedId(null);
            setEditMode(true);
          }}
          onDevice={() => setDevicePicker({ ctrl: selectedCtrl })}
          onTrigger={() => setTriggerPicker({ ctrl: selectedCtrl })}
          triggerLabel={triggerLabelFor(selectedCtrl)}
          onRecord={() => {
            if (recordArmed?.controlId === selectedCtrl.id) {
              // Bereits armiert → nochmal senden hebt es auf (Toggle, siehe Server).
              send({ t: "record.arm", controlId: selectedCtrl.id, laneId: recordArmed.laneId });
            } else {
              setLanePicker({ ctrl: selectedCtrl });
            }
          }}
          onRemove={() => {
            send({ t: "control.delete", controlId: selectedCtrl.id });
            setSelectedId(null);
          }}
        />
      )}

      {lanePicker && (
        <LanePickerPopup
          x={window.innerWidth - DOCK_W - 280}
          y={TOP + 16}
          devices={devices}
          onClose={() => setLanePicker(null)}
          onPick={(lane) => {
            send({ t: "record.arm", controlId: lanePicker.ctrl.id, laneId: lane.id });
            setLanePicker(null);
          }}
        />
      )}

      {triggerPicker && (
        <TriggerPickerPopup
          x={window.innerWidth - DOCK_W - 300}
          y={TOP + 16}
          devices={devices}
          blocks={blocks}
          active={triggerPicker.ctrl.trigger}
          onClose={() => setTriggerPicker(null)}
          onPick={(laneId, slotId) => {
            send({ t: "control.setTrigger", controlId: triggerPicker.ctrl.id, laneId, slotId });
            setTriggerPicker(null);
          }}
          onClear={() => {
            send({ t: "control.setTrigger", controlId: triggerPicker.ctrl.id, laneId: null, slotId: null });
            setTriggerPicker(null);
          }}
        />
      )}

      {devicePicker && (
        <DevicePickerPopup
          x={window.innerWidth - DOCK_W - 260}
          y={TOP + 16}
          devices={devices}
          activeDeviceId={devicePicker.ctrl.deviceId}
          onClose={() => setDevicePicker(null)}
          onPick={(deviceId) => {
            send({ t: "control.setDevice", controlId: devicePicker.ctrl.id, deviceId });
            setDevicePicker(null);
          }}
        />
      )}

      {kindPicker && (
        <KindPickerPopup
          mappingKind={kindPicker.mappingKind}
          onCancel={() => {
            // Cancel cleans up the just-learned control too (same reasoning
            // as promptName's cancel path).
            send({ t: "control.delete", controlId: kindPicker.controlId });
            setKindPicker(null);
          }}
          onPick={(kind) => {
            send({ t: "control.setKind", controlId: kindPicker.controlId, kind });
            const id = kindPicker.controlId;
            setKindPicker(null);
            promptName(id);
          }}
        />
      )}
    </>
  );
}
