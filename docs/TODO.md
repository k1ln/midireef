# Live-performance TODO

Started 2026-09-05: what's missing to make MidiReef feel like a state-of-the-
art live MIDI station. Updated the same day after a long implementation pass
— most of the list shipped. Check items off as they land; each has enough
pointers to start without re-surveying the codebase.

## Removed 2026-09-06 (to be rebuilt properly later)

- **Scenes (SC)**, **Song / Arrangement**, **Mod-Matrix (MX)** and the
  **Fill** performance button were ripped out — half-baked, in the way. Gone
  from server + shared + UI: `scene.*`/`song.*`/`mod.*`/`transport.setFill`
  commands, `ClockCommand::FireSceneTarget`/`PlaySong`/`StopSong`/`SetFill`,
  `Engine::fire_scene_target`/`eval_global_modulators`/`set_fill`, the
  `SongPlayback` clock-thread machinery, `RoutingScene`, `GlobalModulator`,
  `ModRoute`, `TrigCondition::Fill`/`NotFill`, and the
  `scenes`/`songs`/`modulators`/`modRoutes` project fields +
  `fillActive`/`songMode`/`activeSongId`/`activeSceneId`/… transport fields.
  `Engine::stop_lane` kept (`#[allow(dead_code)]`) for the Scenes rebuild.
- **Routing Hub UI (RT)** removed, but its **server plumbing stays** —
  `RoutingHub`/`MidiInputSource`/`MidiRoute`, `routing.*` commands (minus the
  scene ones), `AppState::forward_via_routing`. Dormant until re-fronted.
- **New: Dashboard "Keys links"** — the fast replacement for playing a
  connected controller straight into a synth. `model::KeyLink` (+ `keyLinks`
  on `Project`), `keyLink.add/update/setEnabled/setDevice/move/remove` in
  `ws.rs`, `AppState::forward_key_links` in `state.rs` (own path next to
  `forward_via_routing`; tolerant port match; forwards note/PB/AT/CC play
  messages; many links may be LIVE at once → one controller to several
  synths). UI: `ui/src/app/dashboard/KeyLinkWidget.tsx` draggable canvas
  tiles + "＋ Keys link" transport-bar button (dashboard only) +
  `keyLink.activity` flash.

## Done

- [x] **Scenes** — fire/stop multiple lanes across devices with one touch.
      `Engine::fire_scene_target`/`stop_lane` in `server/src/engine.rs`,
      `ClockCommand::FireSceneTarget` in `clock.rs`,
      `scene.create/update/delete/trigger` in `ws.rs` (raw JSON on
      `project.scenes`, same convention as `blocks`). UI:
      `ui/src/app/Scenes.tsx` ("Scenes" tab), reachable via the "SC"
      transport-bar button.
- [x] **Song / Arrangement mode** — chain scenes with bar counts +
      tempo/time-sig automation. Auto-advance lives entirely in the clock
      thread (`SongPlayback` in `clock.rs` — only that thread knows the pulse
      counter); `song.create/update/delete/play/stop` in `ws.rs`.
      `TransportState` gained `activeSongStepIndex`/`songBarsRemaining` for
      UI progress display. UI: `ui/src/app/Songs.tsx` ("Song" tab, same
      screen as Scenes).
- [x] **Beat-repeat / stutter** — hold a button, grab the last N steps of
      whatever's currently playing and loop them until release, then resume
      exactly where it was (time freezes during the hold, no catch-up).
      `Playback.repeat`/`RepeatState` + `Engine::press_repeat`/
      `release_repeat`, intercepted at the top of the per-lane loop in
      `on_pulse`; `ClockCommand::PressBeatRepeat`/`ReleaseBeatRepeat`. UI: new
      `beatRepeat` `LaneControl` kind via the "Add control" picker
      (melody/chord/arp/beat lanes) — rides the existing generic
      `laneControl.press`/`release` momentary-button plumbing.
- [x] **Manual roll** — hold a button, retrigger one note at a fixed rate
      (hits per quarter note), independent of the pattern's own steps —
      release stops it. `Engine::press_roll`/`release_roll` +
      `ActiveRoll`/`self.rolls`, flushed in `on_pulse` alongside the other
      pending queues; `ClockCommand::PressRoll`/`ReleaseRoll`. UI: `roll`
      `LaneControl` kind (pick note, then rate 1–16 hits/quarter) in the same
      picker as beat-repeat.
- [x] **Note echo / delay** — every note on a lane can get `repeats`
      decaying retriggers at a fixed rate (hits per quarter note), decay is a
      per-repeat velocity multiplier. Distinct from ratchet (fixed count,
      confined to one step) — this is an open-ended tail anchored to the
      note's own (possibly nudged/humanized) onset. `EchoConfig` on `CLane`,
      generated in `fire_step` via the same `PendingOn` queue ratchet/
      humanize already use. `Lane.echo`/`LaneEcho` in `model.rs`,
      `lane.setEcho` in `ws.rs`. UI: Echo on/off + repeats/decay steppers in
      the Lane settings dock (`SettingsDock.tsx`, next to Groove).
- [x] **Swing** — per-lane `Lane.swing: Option<f64>` overrides
      `Project.swing` (now settable via `project.setSwing`, previously dead).
      Implemented as a delay of odd-step trigger points inside their own
      pulse window in `on_pulse` — block length/wrap stay unswung. UI:
      "Groove" card in Settings (project default) + "Groove" field in the
      Lane dock (per-lane override, with a ↺ to fall back to project
      default).
- [x] **Humanize** — per-lane timing/velocity jitter (0..1 each), applied in
      `fire_step` via a dependency-free hash PRNG (`pseudo_rand` — no `rand`
      crate). Timing jitter goes through the same `PendingOn` scheduling
      queue as ratchet echoes. UI: steppers in the Lane dock's Groove field.
- [x] **Per-step probability** — `StepMod.probability`, rolled per-hit in
      `fire_step` before keytrack/emission; a missed roll produces no sound
      and no keytrack impulse. Parsed from block JSON via `StepModJson`
      (`#[serde(flatten)]` onto melody/beat/chord step JSON). No per-step
      *editor* UI yet — see Not done below.
- [x] **Ratchet** — `StepMod.ratchet`, N evenly-spaced retriggers within one
      step's own pulse span, each independently scheduled (first one may
      also carry nudge/humanize, follow-ups stay on-grid so a roll doesn't
      stutter unevenly). No per-step editor UI yet.
- [x] **Micro-timing (nudge)** — `StepMod.microTiming` (-1..1 fraction of a
      step), applied as a pulse offset on a hit's first retrigger, combined
      with humanize-timing before scheduling. No per-step editor UI yet.
- [x] **Trig-conditions** — `fill`/`notFill`/`first`/`notFirst`/`ratio`/
      `probability`, AND'd with `StepMod.probability` in `fire_step`.
      `first`/`notFirst`/`ratio` read `Playback.loops_done` (how many times
      the current block has looped); `fill`/`notFill` read a new
      `Engine::fill_active` flag actually wired up for the first time via
      `transport.setFill` → `ClockCommand::SetFill` (the command existed in
      `shared/model.ts` and `TransportState.fillActive` already existed but
      nothing ever set it). Parsed manually from raw JSON
      (`parse_trig_condition`) rather than a fragile string-or-object serde
      enum. UI: **FILL** toggle button in the transport bar. No per-step
      *editor* UI for authoring conditions yet.
- [x] **Euclidean rhythm generator** — `EuclidConfig` on a `BeatLine`
      generates the on/off pattern at compile time (`euclidean_pattern`,
      verified against the canonical E(3,8) "tresillo" in
      `groove_tests`); manual step velocities remain usable as the loudness
      source per active step. `beat.setEuclid` in `ws.rs`. No UI to actually
      set/edit euclid params on a beat line yet — see Not done below.
- [x] **Choke groups** — `BeatLine.chokeGroup`; firing a hit immediately cuts
      any other still-sounding note in the same group on the same port/
      channel (classic hi-hat open/closed cutoff). `beat.setChokeGroup` in
      `ws.rs`. No UI to set it on a line yet.

## Not done — needs a step/note editor UI

Probability, ratchet, micro-timing, euclid params, and choke groups are all
fully implemented server-side (see above) but have **no UI** to actually set
them on an individual step/note/beat-line — that requires touching the
piano-roll / beat-grid editor components (`BlockDetail.tsx` and friends),
which is a separate, editor-shaped chunk of work rather than a live-
performance one. Worth doing next if per-step programming (not just live
performance controls) is the priority.

## New live-performance effects — not built

- [x] **Glide / portamento** — deliberately NOT a pitch-bend engine feature:
      Midireef drives external MIDI hardware, and virtually every synth has
      its own portamento circuit, so `lane.setGlide` just sends standard
      CC65 (on/off) + CC5 (time) once to the lane's port/channel — the synth
      glides every legato note itself from then on. `Lane.glide`/`LaneGlide`
      in `model.rs`, persisted for UI display but not re-sent automatically
      (e.g. after a synth power-cycle — out of scope for now). UI: On/Off +
      a Time stepper in the Lane settings dock (melody/chord/arp lanes only).
- [x] **Randomizer / glitch / scatter** — hold a `scatter` `LaneControl` and
      every step-trigger on that lane reads a RANDOM step's content instead
      of its own; timing stays exactly on the (possibly swung) grid, release
      returns to normal. `Playback.scatter: bool` + `press_scatter`/
      `release_scatter`, checked right before the normal `fire_step` call in
      `on_pulse`. Deliberately step-content-only, not pitch/octave
      randomization — that risks going out-of-key/out-of-range
      unpredictably, a bigger musical footgun than shuffling which written
      step plays.
- [x] **Live FX insert chain** — resolved as: keep the existing per-effect
      architecture (they already compose fine — nothing stops stacking
      scatter + choke groups + humanize simultaneously), but add a
      **"Live FX" row** to the Lane Controls screen that's always present on
      melody/chord/arp/beat lanes, with zero setup: Beat Repeat and Scatter
      as hold buttons, Echo as a one-tap toggle (sane defaults:
      repeats=3, rateDiv=8, decay=0.6). New direct WS commands
      `lane.pressBeatRepeat`/`releaseBeatRepeat`/`pressScatter`/
      `releaseScatter` in `ws.rs` (same `ClockCommand`s as the LaneControl
      versions, just invocable without pre-adding a control first). Roll
      stays an addable custom control (needs a note picked, doesn't fit a
      zero-setup row).
- [x] **Multi-parameter macro knob** — this IS the Mod-Matrix (see below): a
      `GlobalModulator` routed to several `ModRoute`s at once is exactly "one
      control morphing several CC targets/depths simultaneously." No separate
      feature needed once Mod-Matrix existed.

## Half-built systems — now fully built

- [x] **Routing Hub UI** (done 2026-09-05) — external controller → multiple
      devices live, with channel remap/note transpose/velocity scale/CC
      remap, plus Routing Scenes to bulk-switch which routes are active
      ("all controllers → Synth B", no cable/re-learn). Was TypeScript-only
      before this: `RoutingHub`/`MidiRoute`/etc. existed only in
      `shared/model.ts`, with zero Rust types, zero WS handling, zero engine
      behavior. Now: typed `RoutingHub`/`MidiInputSource`/`MidiRoute`/
      `RoutingScene` in `model.rs` (replacing the old raw-JSON placeholder);
      `AppState::forward_via_routing` in `state.rs` hooks into the EXISTING
      MIDI-input stream in `spawn_midi_learn` (`main.rs`) — the same thread
      that already reads every incoming MIDI message for Learn/record/note-
      input, just one more independent consumer of it, so no new MIDI
      infrastructure was needed. Activating a Routing Scene means "exactly
      these routes on, everything else off" (`route.enabled` is the only
      thing forwarding checks — no separate active-scene lookup per message).
      `routing.*` commands in `ws.rs` (added `routing.deleteScene`, missing
      from the original spec). UI: `ui/src/app/Routing.tsx`, "RT"
      transport-bar button, three tabs (Sources/Routes/Scenes).
- [x] **Global Modulator / Mod-Matrix UI** (done 2026-09-05) — same
      greenfield situation as Routing Hub (TS-only before this). Typed
      `GlobalModulator`/`ModRoute` in `model.rs`; `Engine::eval_global_
      modulators` runs once per pulse (not per-lane — a modulator has no
      lane), reuses the existing `eval_waveform` free function the per-block
      CC-LFO layers already use, sends CC centered at 64 and scaled by
      `depth` (standard mod-matrix convention — the destination needs its own
      base value set elsewhere), rate-limited via the same `CcSendState`/
      `MIN_CC_SEND_INTERVAL` pattern as CC blocks. `mod.*` commands in
      `ws.rs` (added `mod.updateRoute`, missing from the original spec — the
      UI needs to edit a route's depth, not just add/remove it). UI:
      `ui/src/app/ModMatrix.tsx`, "MX" transport-bar button.

## What's left

Step/note editor UI for probability/ratchet/micro-timing/euclid/choke groups
(all server-complete, all unreachable from touch — see "Not done" above) is
the one remaining real gap. It's piano-roll/beat-grid editor work
(`BlockDetail.tsx` and friends), not live-performance work, so it's a
different kind of task than everything else in this file — worth a separate
pass when per-step programming (not just live performance controls) is the
priority.
