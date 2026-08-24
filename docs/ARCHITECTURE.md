# MidiDrift — Architektur & Konzept

> Touch-only MIDI-Automations-Software im Unterwasser-Look.
> Läuft im Kiosk-Modus auf einem Raspberry Pi 5 mit Touchdisplay.

---

## 1. Grundprinzip: strikte Trennung UI ↔ MIDI-Server

```
┌─────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│  UI  (Browser, Fullscreen Kiosk)         │        │  MIDI-Server  (Rust, Headless)       │
│                                          │        │                                      │
│  • React-Frontend (alle Screens/Touch)   │  WS    │  • Zentrale MIDI-Clock (24 PPQN)     │
│  • PixiJS nur im Hintergrund (§6)        │◄──────►│  • midir + OS-Timestamp-Scheduler    │
│  • Touch-only + Touch-Keyboard           │  JSON  │  • MIDI I/O (Out/In, CC, Notes, PC)  │
│  • Kein Timing, kein MIDI                │        │  • Projekt-Persistenz (JSON-Dateien) │
│  • Nur Darstellung + Bedien-Events       │        │  • MIDI-Learn                        │
└─────────────────────────────────────────┘        └──────────────────────────────────────┘
```

- **Die UI ist „dumm".** Sie sendet Absichten (`play`, `triggerBlock`, `setControlValue`) und rendert den vom Server gepushten Zustand. Kein Timing-Code im Browser.
- **Der Server ist die einzige Zeitquelle.** Er hält Transport, Clock, Scheduling und alle MIDI-Ausgabe.
- **Kommunikation:** WebSocket, JSON-Nachrichten. UI → Server = Commands; Server → UI = State-Patches + hochfrequente Transport-Ticks (gethrottelt auf ~30–60 Hz fürs Rendering, **nicht** die echte Clock).
- **Rendering-Split innerhalb der UI** (siehe §6 für Details): der Browser-Prozess trägt zwei übereinanderliegende Ebenen — `#pixi-bg` (Canvas, `pointer-events: none`) rendert ausschließlich die Unterwasser-Hintergrundszene + den Touch-Ripple-Effekt; `#react-root` (DOM, darüber) ist das komplette interaktive Frontend (Transport, Dashboard, Sequencer Overview, Baustein-Detail/-Bibliothek, Lane-Controls, Touch-Keyboard). Beide Ebenen teilen sich `state.ts`'s `Store` und `net.ts`'s `Net` (framework-agnostische Pub-Sub-Klassen, unverändert) — React hängt sich per `useSyncExternalStore`-Hook daran (`ui/src/app/store.ts`).

---

## 2. Technologie-Entscheidungen

| Bereich        | Wahl                              | Begründung |
|----------------|-----------------------------------|------------|
| Server         | **Rust**                          | Was moderne Open-Source-MIDI-Tools nutzen; kein GC, deterministisches Timing. |
| MIDI-Lib       | **`midir`** (I/O) + **`midly`** (Parsing) | Cross-platform: CoreMIDI (Mac Dev) / ALSA (Pi Deploy), aktiv gepflegt. |
| Timing         | **OS-Timestamping + Look-Ahead**  | ALSA-seq / CoreMIDI dispatchen zeitgestempelt im Kernel → Sub-ms, GC-unabhängig. |
| Web/WS-Layer   | `axum` + `tokio-tungstenite`      | Async WebSocket-Server in Rust, leichtgewichtig. |
| Serialisierung | `serde` / `serde_json`            | Rust-Typen spiegeln [`shared/model.ts`](../shared/model.ts) 1:1. |
| UI-Rendering   | **React (Frontend) + PixiJS (Hintergrund)** | React: native DOM-Layout/Scroll/Events statt Pixi-Hitboxen und Hand-Pixel-Layout für jeden Screen. PixiJS bleibt exklusiv für die WebGL-Partikelszene (§6) — dort lohnt sich das GPU-Rendering wirklich, für Buttons/Listen/Popups nicht. |
| Persistenz     | **JSON-Dateien**                  | Einfach kopierbar (Projekte duplizieren), versionierbar, kein DB-Setup. |

> **Sprach-Trennung ist sauber:** UI ist ein eigener Browser-Prozess (PixiJS/JS), Server ist Rust.
> Beide teilen nur das JSON-Datenmodell über WebSocket — die Rust-Komplexität bleibt im Server.
> Das Datenmodell in [`shared/model.ts`](../shared/model.ts) wird serverseitig via `serde`-Structs gespiegelt.

---

## 3. Timing-Modell (das Herzstück)

- **Auflösung intern:** hoch (z.B. 960 PPQN) für exakte Note-/CC-Platzierung.
- **MIDI-Clock nach außen:** genau **24 PPQN** (Standard), plus `Start` / `Stop` / `Continue` und `Song Position Pointer`.
- **OS-Timestamping (primär):** Events werden **mit absolutem Zeitstempel** an ALSA-seq (Pi) bzw. CoreMIDI (Mac) übergeben. Der Kernel/Treiber dispatcht sie präzise — unabhängig vom App-Scheduling. Das ist der Profi-Ansatz für Sub-ms-Genauigkeit.
- **Look-Ahead-Loop (Rust/`tokio`, füllt den Timestamp-Puffer):**
  1. Loop läuft eng (z.B. alle ~5 ms) auf einem dedizierten Thread.
  2. Engine berechnet alle Events im Fenster `[jetzt, jetzt + 25 ms]`.
  3. Events werden **zeitgestempelt** in die OS-MIDI-Queue geschrieben.
  4. Da Rust keinen GC hat und das OS das finale Dispatch übernimmt, gibt es kein hörbares Eiern.

```
BPM ──► Ticks/Sekunde ──► Look-Ahead-Fenster ──► OS-MIDI-Queue (Timestamp) ──► Hardware
                     └──► UI-Transport-Push (gethrottelt, nur Anzeige)
```

---

## 4. Sequencer-Konzept

```
Projekt
 └─ Device (z.B. "TR-8S")
     ├─ Baustein-Bibliothek  (schwebende Tabelle, 1-1 … 9-9 pro Typ)
     │    ├─ Melodie-Bausteine
     │    ├─ Beat-Bausteine
     │    ├─ CC-Automation-Bausteine
     │    └─ Pattern-Shift-Bausteine
     └─ Lanes (mehrere, an/aus, ein/ausblendbar)
          └─ Slots  → Referenz auf Baustein  + Platzierungs-Overrides
                       (Transpose, Speed, Loop, Trigger-Quantisierung)
```

- **Baustein** = 1+ Takte, läuft bis fertig. Wird ausgelöst per Touch — sofort oder quantisiert zum nächsten Taktanfang.
- **Benennung:** Lanes sind frei benennbar (Touch-Keyboard). Bausteine sind ebenfalls benennbar, aber **max. 6 Zeichen** (kurz & touch-freundlich, `BLOCK_NAME_MAX_LENGTH`).
- **Lane-Abspielmodi:** `sequential` (hintereinander), `random` (zufällig aus den Slots **dieser** Lane), `manual` (nur per Touch).
- **Parallele Lanes:** Mehrere aktive Lanes eines Devices klingen **gleichzeitig** (polyphon pro Device).
- **Referenz + Overrides:** Ein Lane-Slot referenziert den Bibliotheks-Baustein; Änderungen am Original wirken überall. Transpose/Speed/Loop sind Overrides **pro Platzierung**.
- **Skalen-Quantisierung:** Beim Transponieren können Noten optional in eine wählbare Tonleiter gezwungen werden (keine „falschen" Töne). Projekt-Default + optional pro Baustein.
- **In der Lane-Ansicht:** nur Schnellbedienung (Trigger, Transpose, Speed, Mute) — **keine** Noten-Bearbeitung. Noten editiert man im Baustein-Detail.

---

## 4a. Lane-Management

Lanes werden **pro Device frei angelegt** und verwaltet. **Jede Lane ist rein auf genau einen Baustein-Typ festgelegt** — man legt beim Anlegen den Typ fest, und die Lane hostet nur Bausteine dieses Typs. Der Typ bestimmt zugleich, welche **Schnell-Controls** man in ihr anlegen kann.

### Lane-Typ & seine Schnell-Controls

| Lane-Typ | hostet Bausteine | anlegbare Lane-Controls |
|----------|------------------|--------------------------|
| **melody** | nur Melodie | **Noten/Frequenz-Controls** (feste Töne live auslösen), Slot-Trigger, Transpose/Speed |
| **chord** | nur Chord | Noten/Frequenz-Controls, Slot-Trigger |
| **arp** | nur Arp | Noten/Frequenz-Controls, Slot-Trigger |
| **beat** | nur Beat | **Drum-Buttons** (Drum-Note feuern) & **Mute-Buttons** pro Beat-Line |
| **cc** | nur CC-Automation | **Macro-Knobs** (CC live steuern) |
| **programChange** | nur ProgramChange | **MIDI-Signal-Buttons** (PC/Bank senden) |
| **patternShift** | nur PatternShift | **MIDI-Signal-Buttons** (Pattern-Wechsel Aira via PC/CC) |

> Reine Typ-Lanes halten die Bedienung einfach und eindeutig: eine Bassline-Lane, eine Drum-Lane, eine Filter-CC-Lane usw. Man kann pro Device beliebig viele Lanes je Typ anlegen.

### Control-Auslöse-Verhalten
- **momentary** — gedrückt halten: Note-On bei Touch-Down, Note-Off bei Touch-Up.
- **toggle** — an/aus umschalten (bleibt).
- **oneShot** — einmaliger Impuls (z.B. Program-Change senden).

### Verwaltungs-Operationen (alle touch-freundlich)
- **Lane anlegen** (neue Lane mit Rolle wählen), **duplizieren**, **löschen**, **umbenennen** (Touch-Keyboard).
- **Reihenfolge** per Drag ändern; **Farbe** setzen (Codierung im UI).
- **Status pro Lane:** `enabled` (läuft mit), `muted` (stumm, läuft weiter), `solo` (nur Solo-Lanes klingen), `visible` (ein/ausblenden), `collapsed` (Zeile einklappen), `height` (Touch-Größe).
- **Channel-Override** pro Lane (sonst Device-Channel).
- **Controls verwalten:** hinzufügen, bearbeiten, entfernen, per Drag umsortieren; live drücken/loslassen/Wert setzen.

### Beispiel-Layouts
```
Device "TR-8S"
 ├─ Lane "Kick+Snare"   [beat]   → Buttons: [Kick] [Snare] [Clap]  | Mutes: [BD][SD][CH][OH]
 ├─ Lane "Bassline"     [melody] → Noten:  [C1] [G1] [Eb2] [Bb1]   | Slots: [1-1][1-2]
 ├─ Lane "Filter"       [cc]     → Macro:  (Cutoff) (Reso)          | Slots: LFO-Baustein
 └─ Lane "Patterns"     [patternShift] → Signale: [Ptn A] [Ptn B] [Var]
```

Das Datenmodell dazu: `LaneRole` (= `BlockType`, reine Typ-Lanes), `LaneControl` (`NoteControl` / `DrumButtonControl` / `MidiSignalControl` / `MacroKnobControl` / `SlotTriggerControl`) und die `lane.*` / `laneControl.*` Commands in [`shared/model.ts`](../shared/model.ts).

---

## 4b. Routing-Hub (Controller on-the-fly umrouten)

MidiDrift ist zugleich ein **MIDI-Routing-Hub**: externe Controller werden **ohne Kabelwechsel** live auf verschiedene Synths/Devices geroutet. Ein Knob deines Keyboards steuert erst Synth A (Cutoff), per Touch dann Synth B — ohne Umstecken, ohne neues Learn.

- **`MidiInputSource`** — ein physischer MIDI-Eingang (benennbar, z.B. „Launchkey").
- **`MidiRoute`** — leitet **gefilterte** Nachrichten (Note/CC/PB/AT/NRPN/SysEx, Noten-/CC-Bereiche) einer Quelle an ein Ziel-Device, mit **Remapping** (Kanal, CC-Umnummerierung, Transpose, Velocity-Scale).
- **`RoutingScene`** — aktiviert on-the-fly eine ganze Menge Routen (z.B. „alle Controller → Synth B"). Das ist der Kern des kabellosen Umschaltens.
- UI-Feedback: `routing.activity` blinkt die Route, wenn Daten durchlaufen.

```
Launchkey ─┐                        ┌─► TB-3  (Route: CC74→Cutoff, Ch 2)
           ├─ RoutingScene "Live A" ─┤
Beatstep  ─┘                        └─► TR-8S (Route: Notes 36-51, Ch 10)
   (per Touch → RoutingScene "Live B" routet alles auf System-1)
```

---

## 4c. Profi-Sequencing & MIDI-Tiefe

- **Per-Step (`StepMod`):** Probability, **Trig-Conditions** (`1:4`, fill/notFill, first/notFirst), **Ratchets/Rolls**, **Micro-Timing** — auf Melodie-/Beat-/Chord-Events.
- **Euclidean-Generator** (`EuclidConfig`) pro Beat-Line; **Choke-Groups** (HiHat-Logik).
- **Swing & Humanize pro Lane** (Timing/Velocity), zusätzlich zum Projekt-Swing.
- **Scenes** (`Scene`): mehrere Lanes/Devices mit einem Touch starten/stoppen.
- **Song-/Arrangement-Mode** (`Song` / `SongStep`): Scenes verketten, inkl. Tempo-/Taktart-Automation.
- **MIDI-Input-Recording** (`RecordSettings`): Performance in Bausteine aufnehmen, mit Quantize/Overdub/Count-in.
- **Clock-Source** (`ClockSource`): intern **senden**, zu externer MIDI-Clock **syncen**, oder **Ableton Link** (Netzwerk).
- **Volle MIDI-Palette** (`MidiMessageKind`): Note, CC, PC, Pitch-Bend, Channel-/Poly-Aftertouch, **NRPN/RPN**, **SysEx**.
- **Device-Profile** (`DeviceProfile`): benannte CC/PC/NRPN-Maps (z.B. „TR-8S" → „Cutoff" statt „CC 74") — großer Touch-Usability-Gewinn.
- **Globale Modulatoren + Mod-Matrix** (`GlobalModulator` / `ModRoute`): ein LFO auf mehrere Ziele.
- **Panic** (All-Notes-Off), **Undo/Redo**, **Copy/Paste** (Blocks/Lanes), **Control-Snapshots**, **Per-Device-Latenz-Offset**, **CC-Slew/Kurven**, **MPE** (optional).

---

## 5. Bildschirme (Touch-Navigation)

1. **Transport-Leiste (immer oben):** Play/Stop, BPM, Clock-Status, Projekt-Name.
2. **Startbildschirm / Live-Control:** Alle MIDI-Knobs/Buttons/Fader live bedienbar.
   - **Long-Press** → MIDI-Learn startet → eingehende MIDI-Nachricht drücken → Zuordnung → mit **Touch-Keyboard** benennen.
   - Controls per Drag auf einen **individuellen Screen** verschiebbar.
3. **Sequencer Overview:** Tabelle aller Devices/Lanes/Bausteine.
4. **Device-Ansicht:** Lanes an/aus, ein-/ausblenden; Baustein-Bibliothek.
5. **Baustein-Detail:** Noten/Beats/CC-Kurven editieren (Melodie, Beat-Lines mit Mute, CC-Layer wie LFO), inkl. Per-Step Probability/Conditions/Ratchets.
6. **Scenes & Song:** Scenes anlegen/starten, Arrangement (Song) zusammenstellen.
7. **Routing-Hub:** Quellen/Routen verwalten, Routing-Scenes on-the-fly umschalten.
8. **Projekt-Verwaltung:** anlegen, kopieren, wechseln.

Navigation: Overview → Device → Lane → Baustein (immer tiefer, immer touch-freundlich, große Flächen).

---

## 6. Unterwasser-Look (PixiJS-Hintergrund + React-Frontend)

- **Layering:** `index.html` mountet zwei volle Viewport-Ebenen — `#pixi-bg` (Canvas, `pointer-events: none`, z-index 0) und `#react-root` (DOM, z-index 1, darüber). `ui/src/main.tsx` startet beide: `mountBackground()` (`ui/src/background.ts`) für die Pixi-Seite, `createRoot(...).render(<App />)` (`ui/src/app/App.tsx`) für React.
- **Pixi-Hintergrund** (`ui/src/scene/underwater.ts`, unverändert seit vor dem React-Umbau): Farbverlauf Tiefsee → hellere Oberfläche, Kaustik-Lichtbänder, **Seifenblasen** (aufsteigend), **Plankton**, **Algen** (wiegend, von Krabben/Schnecken abgefressen), **Fische/Haie/Schildkröten/Quallen**. Braucht kein eigenes Interaktionssystem — nichts darin ist tappable.
- **Touch-Ripple** (`ui/src/ui/ripple.ts`): ein `window`-`pointerdown`-Listener prüft `getComputedStyle(target).cursor === "pointer"` auf dem tatsächlich getroffenen DOM-Element (egal ob React-Button, -Tile, -Keyboard-Taste, …) und zeichnet den expandierenden Ring in die Pixi-Ebene — die einzige Stelle, an der Hintergrund und Frontend sich berühren.
- **React-Frontend** (`ui/src/app/`): jeder Screen ist eine eigene Komponente (`Transport`, `Dashboard`, `overview/Overview`, `BlockDetail`, `BlockLibrary`, `LaneControls`, `TouchKeyboard`, `NotePicker`), Layout per Flexbox/Grid/`overflow: auto` statt Hand-Pixel-Positionierung; `theme.css` spiegelt `theme.ts`'s Palette als CSS-Variablen.
- Performance: die Partikelszene bleibt WebGL/Pixi (Ziel 60 FPS auf dem Pi 5, Fallback-Qualitätsstufe); das Frontend ist normales DOM-Rendering.

---

## 7. Deployment

- **Dev:** macOS (CoreMIDI). Server + UI lokal, Browser im Fenster.
- **Deploy:** Raspberry Pi 5, Chromium im Kiosk-Modus (`--kiosk`), Server als `systemd`-Service, MIDI über ALSA.
- Ein virtuelles Touch-Keyboard wird in der UI implementiert (nicht das OS-Keyboard), damit alles im Look bleibt.

---

## 8. WebSocket-Protokoll (Übersicht)

**UI → Server (Commands):**
`transport.play/stop/setBpm/tapTempo/panic/setClockSource/setFill/setMetronome`,
`record.arm/start/stop/setSettings`,
`edit.undo/redo`, `block.copy/paste`, `lane.copy/paste`,
`lane.*` (create/duplicate/delete/rename/reorder/setRole/setColor/setChannel/setEnabled/setVisible/setMuted/setSolo/setCollapsed/setHeight/setPlayMode/setTriggerQuantize/setSwing/setHumanize),
`laneControl.*` (add/update/remove/reorder/press/release/setValue), `laneSlot.*`,
`block.*` (trigger/rename/setTranspose/setSpeed/setLoop/setStepMod), `beat.setLineMuted/setEuclid`,
`scene.*` (create/trigger/update/delete), `song.*` (create/update/delete/play/stop),
`routing.*` (addSource/updateSource/removeSource/addRoute/updateRoute/removeRoute/setRouteEnabled/activateScene/saveScene),
`mod.*` (addModulator/updateModulator/removeModulator/addRoute/removeRoute),
`device.setProfile/setLatency`, `profile.*`, `snapshot.save/recall/delete`,
`control.setValue/startLearn/assignName`, `project.create/copy/load/save`.

**Server → UI (Events):**
`state.snapshot` (voller Zustand beim Verbinden),
`state.patch` (Teil-Updates),
`transport.tick` (Position, gethrottelt fürs Rendering),
`learn.captured` (eingehende MIDI-Nachricht beim Lernen),
`record.captured` (Aufnahme in Baustein geschrieben),
`routing.activity` (Route hat Daten durchgeleitet — UI-Feedback),
`midi.ports` (verfügbare Ein-/Ausgänge).

Das konkrete, typisierte Datenmodell liegt in [`shared/model.ts`](../shared/model.ts).
