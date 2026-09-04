//! WebSocket-Endpunkt: empfängt Commands (UI → Server) und pusht Events
//! (Server → UI). Command-Dispatch fürs Grundgerüst: Transport + Projekt.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};

use crate::clock::ClockCommand;
use crate::midi;
use crate::model::{ClockSource, Device, Lane, Project};
use crate::net_ap;
use crate::state::AppState;

/// Port, auf dem der Server lauscht — gleiche Ableitung wie in `main.rs`. Geht
/// nur in die `network.state`-Anzeige ein (die Beitritts-URL des AP).
fn server_port() -> u16 {
    std::env::var("MIDIREEF_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787)
}

/// Ermittelt den Ist-Zustand des WLAN-AP (blockierend: `sudo`/`nmcli`) und
/// broadcastet `network.state` an alle Clients. Läuft in einem Task, damit der
/// Command-Loop nicht wartet.
fn broadcast_network_state(state: &AppState) {
    let cfg = state.network.lock().unwrap().clone();
    let events = state.events.clone();
    let port = server_port();
    tokio::spawn(async move {
        let active = if net_ap::supported() {
            tokio::task::spawn_blocking(net_ap::status)
                .await
                .map(|(a, _)| a)
                .unwrap_or(false)
        } else {
            false
        };
        let _ = events.send(net_ap::state_event(&cfg, port, active));
    });
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Kennung des ausgelieferten UI-Builds. Das Deploy-Skript schreibt
/// `<ui-dir>/.build-id` (Git-SHA + Zeitstempel); fehlt die Datei — etwa im
/// Vite-Dev-Betrieb, wo HMR das Nachladen übernimmt — bleibt die Kennung
/// konstant und es wird nie neu geladen.
fn ui_build_id() -> String {
    let dir = std::env::var("MIDIREEF_UI_DIR").unwrap_or_else(|_| "./ui".into());
    std::fs::read_to_string(std::path::Path::new(&dir).join(".build-id"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "dev".into())
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();

    // Beim Verbinden zuerst die Build-Kennung: der Client vergleicht sie mit
    // der, die beim Laden der Seite galt, und lädt sich bei Abweichung neu.
    // Da `net.ts` nach einem Server-Neustart automatisch reconnected, reicht
    // ein Deploy + Dienst-Neustart, damit der Kiosk-Browser die neue UI holt —
    // ohne Chromium neu zu starten.
    let hello = serde_json::json!({ "t": "server.hello", "uiBuild": ui_build_id() });
    let _ = sender.send(Message::Text(hello.to_string())).await;

    // Beim Verbinden: verfügbare MIDI-Ports + voller Zustand.
    let (outputs, inputs) = midi::list_ports();
    let ports = serde_json::json!({ "t": "midi.ports", "outputs": outputs, "inputs": inputs });
    let _ = sender.send(Message::Text(ports.to_string())).await;
    let _ = sender
        .send(Message::Text(state.snapshot_event().to_string()))
        .await;
    let list = serde_json::json!({
        "t": "project.list",
        "projects": state.list_projects(),
        "currentId": state.project.lock().unwrap().id.clone(),
    });
    let _ = sender.send(Message::Text(list.to_string())).await;

    // WLAN-Access-Point-Zustand — wie midi.ports nur an diesen Client. Der
    // Ist-Zustand (`active`) kommt blockierend vom Helfer, daher spawn_blocking.
    {
        let cfg = state.network.lock().unwrap().clone();
        let active = if net_ap::supported() {
            tokio::task::spawn_blocking(net_ap::status)
                .await
                .map(|(a, _)| a)
                .unwrap_or(false)
        } else {
            false
        };
        let evt = net_ap::state_event(&cfg, server_port(), active);
        let _ = sender.send(Message::Text(evt.to_string())).await;
    }

    // Task: Broadcast-Events an diesen Client weiterleiten.
    let forward = tokio::spawn(async move {
        while let Ok(evt) = rx.recv().await {
            if sender.send(Message::Text(evt.to_string())).await.is_err() {
                break;
            }
        }
    });

    // Eingehende Commands verarbeiten.
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(txt) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                dispatch(&state, val);
            }
        }
    }

    forward.abort();
    // Verbindung weg: ein noch armierter Piano-Roll-Editor kann nichts mehr
    // eintragen — und seine gehaltenen Töne würden sonst hängen bleiben.
    set_note_input(&state, None);
}

fn dispatch(state: &AppState, cmd: serde_json::Value) {
    let t = cmd.get("t").and_then(|v| v.as_str()).unwrap_or("");
    match t {
        "transport.play" => state.clock.send(ClockCommand::Play),
        "transport.stop" => state.clock.send(ClockCommand::Stop),
        "transport.tapTempo" => state.clock.send(ClockCommand::TapTempo),
        "transport.panic" => state.clock.send(ClockCommand::Panic),
        "transport.setBpm" => {
            if let Some(bpm) = cmd.get("bpm").and_then(|v| v.as_f64()) {
                state.project.lock().unwrap().bpm = bpm;
                state.clock.send(ClockCommand::SetBpm(bpm));
            }
        }
        "transport.setClockSource" => {
            let src = match cmd.get("source").and_then(|v| v.as_str()) {
                Some("externalMidi") => ClockSource::ExternalMidi,
                Some("link") => ClockSource::Link,
                _ => ClockSource::Internal,
            };
            state.clock.send(ClockCommand::SetClockSource(src));
        }
        // ── Server-Wartung (Einstellungen → Server) ──
        "server.log" => {
            let _ = state.events.send(serde_json::json!({
                "t": "server.logLines",
                "lines": crate::logbuf::recent(),
            }));
        }
        "server.restart" => {
            tracing::warn!("Server-Neustart auf Anforderung der UI");
            let _ = state.events.send(serde_json::json!({ "t": "server.restarting" }));
            // Kurz warten, damit das Event noch rausgeht; dann Prozess beenden —
            // systemd (`Restart=always`) startet ihn in ~1 s neu, die UI
            // reconnected von selbst (net.ts).
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(250));
                std::process::exit(0);
            });
        }
        "project.save" => {
            if let Err(e) = state.save_project() {
                tracing::warn!("Projekt speichern fehlgeschlagen: {e}");
            }
            broadcast_project_list(state);
        }
        "project.list" => broadcast_project_list(state),
        "project.create" => {
            let name = cmd
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Neues Projekt");
            switch_project(state, Project::new(name), true);
        }
        "project.copy" => {
            // Dupliziert das GEÖFFNETE Projekt (nicht `sourceId` von Platte) —
            // so wandern auch noch nicht gespeicherte Änderungen mit in die
            // Kopie, und man landet direkt in ihr statt im Original.
            let mut copy = state.project.lock().unwrap().clone();
            copy.id = uuid::Uuid::new_v4().to_string();
            copy.name = cmd
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} Kopie", copy.name));
            copy.created_at = crate::model::now_iso();
            switch_project(state, copy, true);
        }
        "project.load" => {
            if let Some(id) = cmd.get("projectId").and_then(|v| v.as_str()) {
                match state.load_project(id) {
                    Ok(p) => switch_project(state, p, true),
                    Err(e) => tracing::warn!("Projekt laden fehlgeschlagen: {e}"),
                }
            }
        }
        "project.rename" => {
            if let Some(name) = str_field(&cmd, "name") {
                state.project.lock().unwrap().name = name;
                broadcast_snapshot(state);
                broadcast_project_list(state);
            }
        }
        "project.delete" => {
            if let Some(id) = str_field(&cmd, "projectId") {
                if let Err(e) = state.delete_project_file(&id) {
                    tracing::warn!("Projekt löschen fehlgeschlagen: {e}");
                }
                let is_current = state.project.lock().unwrap().id == id;
                if is_current {
                    // Das offene Projekt wurde gelöscht — auf das nächstneuere
                    // wechseln (sonst zeigt die UI ein Projekt, das es nicht
                    // mehr gibt, und der nächste Auto-Save legt es wieder an).
                    // `save_current: false`, sonst schriebe genau dieser
                    // Auto-Save die gerade gelöschte Datei zurück.
                    let next = crate::state::load_most_recent_project_from(&state.data_dir)
                        .unwrap_or_else(|| Project::new("MidiReef"));
                    switch_project(state, next, false);
                } else {
                    broadcast_project_list(state);
                }
            }
        }
        // ── Devices ──
        "device.create" => {
            let name = cmd
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let port = cmd
                .get("midiOutPort")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            {
                let mut proj = state.project.lock().unwrap();
                let n = name.unwrap_or_else(|| format!("Device {}", proj.devices.len() + 1));
                proj.devices.push(Device::new(n, port));
            }
            broadcast_snapshot(state);
        }
        "device.rename" => {
            if let (Some(id), Some(name)) = (str_field(&cmd, "deviceId"), str_field(&cmd, "name")) {
                with_device(state, &id, |d| d.name = name.clone());
            }
        }
        "device.delete" => {
            if let Some(id) = str_field(&cmd, "deviceId") {
                state.project.lock().unwrap().devices.retain(|d| d.id != id);
                broadcast_snapshot(state);
            }
        }
        "device.setPort" => {
            if let (Some(id), Some(port)) =
                (str_field(&cmd, "deviceId"), str_field(&cmd, "midiOutPort"))
            {
                with_device(state, &id, |d| d.midi_out_port = port.clone());
            }
        }
        "device.setSendClock" => {
            if let (Some(id), Some(on)) = (
                str_field(&cmd, "deviceId"),
                cmd.get("sendClock").and_then(|v| v.as_bool()),
            ) {
                with_device(state, &id, |d| d.send_clock = on);
            }
        }
        // Schnell-Mute des ganzen Geräts — alle Lanes schweigen (s.
        // `dev_muted` in engine.rs), Positionen laufen weiter.
        "device.setMuted" => {
            if let (Some(id), Some(on)) = (
                str_field(&cmd, "deviceId"),
                cmd.get("muted").and_then(|v| v.as_bool()),
            ) {
                with_device(state, &id, |d| d.muted = on);
            }
        }
        // ── Lanes ──
        "lane.create" => {
            if let Some(device_id) = str_field(&cmd, "deviceId") {
                let role = str_field(&cmd, "role").unwrap_or_else(|| "melody".to_string());
                let name = str_field(&cmd, "name");
                {
                    let mut proj = state.project.lock().unwrap();
                    // Starter-Baustein zuerst in die projektweite Bibliothek.
                    let mut starter_slot: Option<String> = None;
                    if let Some(mut block) = default_block_for(&role) {
                        if let Some((row, col)) = next_free_slot(&proj.blocks, &role) {
                            block["slot"] =
                                serde_json::json!({ "type": role, "row": row, "col": col });
                            let block_id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            if let Some(arr) = proj.blocks.as_array_mut() {
                                arr.push(block);
                            }
                            starter_slot = Some(block_id);
                        }
                    }
                    if let Some(d) = proj.devices.iter_mut().find(|d| d.id == device_id) {
                        let n = name
                            .clone()
                            .unwrap_or_else(|| format!("Lane {}", d.lanes.len() + 1));
                        let mut lane = Lane::new(&role, n);
                        if let Some(block_id) = starter_slot {
                            lane.slots = serde_json::json!([demo_slot(&block_id)]);
                        }
                        d.lanes.push(lane);
                    }
                }
                broadcast_snapshot(state);
            }
        }
        "lane.rename" => lane_str(state, &cmd, "name", |l, v| l.name = v),
        "lane.setColor" => lane_str(state, &cmd, "color", |l, v| l.color = Some(v)),
        "lane.delete" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                {
                    let mut proj = state.project.lock().unwrap();
                    for d in proj.devices.iter_mut() {
                        d.lanes.retain(|l| l.id != lane_id);
                    }
                }
                broadcast_snapshot(state);
            }
        }
        "lane.setEnabled" => lane_bool(state, &cmd, "enabled", |l, v| l.enabled = v),
        "lane.setVisible" => lane_bool(state, &cmd, "visible", |l, v| l.visible = v),
        "lane.setMuted" => lane_bool(state, &cmd, "muted", |l, v| l.muted = v),
        "lane.setSolo" => lane_bool(state, &cmd, "solo", |l, v| l.solo = v),
        "lane.setCollapsed" => lane_bool(state, &cmd, "collapsed", |l, v| l.collapsed = v),
        "lane.setPlayMode" => lane_str(state, &cmd, "mode", |l, v| l.play_mode = v),
        // immediate | nextBeat | nextBar | nextBlock — s. Engine::trigger_slot.
        "lane.setTriggerQuantize" => {
            lane_str(state, &cmd, "quantize", |l, v| l.trigger_quantize = v)
        }
        // MIDI-Kanal der Lane (1–16). Sitzt bewusst hier und nicht am Baustein:
        // Bausteine sind reiner Inhalt und sollen in mehreren Lanes auf
        // verschiedenen Kanälen wiederverwendbar sein.
        "lane.setChannel" => {
            if let (Some(lane_id), Some(ch)) = (
                str_field(&cmd, "laneId"),
                cmd.get("channel").and_then(|v| v.as_u64()),
            ) {
                let ch = (ch as u8).clamp(1, 16);
                with_lane(state, &lane_id, |l| l.channel = ch);
            }
        }
        // Ziel-Knob einer CC-Lane setzen (controlId null → Ziel lösen). Erlaubt
        // sind NUR gelernte Knobs, die zum Device dieser Lane gehören und ein
        // CC-Mapping haben — alles andere hätte kein sendbares Ziel und würde
        // in der Engine ohnehin verworfen (s. `resolve_cc_target`).
        "lane.setCcControl" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                let control_id = str_field(&cmd, "controlId");
                {
                    let mut proj = state.project.lock().unwrap();
                    let allowed = match &control_id {
                        Some(cid) => lane_can_target_control(&proj, &lane_id, cid),
                        None => true,
                    };
                    if allowed {
                        if let Some(l) = find_lane_mut(&mut proj, &lane_id) {
                            l.cc_control_id = control_id;
                        }
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // Trigger-Kette einer Lane setzen/lösen: wird ein Slot DIESER Lane
        // ausgelöst, feuert zusätzlich (targetLaneId, targetSlotId) mit — z.B.
        // eine Melodie-Lane, die einen CC-Effekt mitzündet. Fehlt eines der
        // Ziel-Felder (oder null) → Kette entfernen.
        "lane.setChainSlot" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                let target_lane = str_field(&cmd, "targetLaneId");
                let target_slot = str_field(&cmd, "targetSlotId");
                with_lane(state, &lane_id, |l| {
                    l.chain_slot = match (target_lane.clone(), target_slot.clone()) {
                        (Some(tl), Some(ts)) => Some(crate::model::ChainSlot {
                            lane_id: tl,
                            slot_id: ts,
                        }),
                        _ => None,
                    };
                });
            }
        }
        // Keytrack-Quelle einer CC-Lane setzen/lösen (sourceLaneId null → lösen):
        // die gewählte Melodie-Lane treibt fortan mit ihren gespielten Noten das
        // LFO-Key-Tracking (`rateKeyTrack`) dieser Lane — s. `Engine::fire_step`.
        // Nur Melodie-Lanes sind ein gültiges Ziel (sonst hätte „key" keine
        // Bedeutung).
        "lane.setKeytrackSource" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                let source_lane_id = str_field(&cmd, "sourceLaneId");
                {
                    let mut proj = state.project.lock().unwrap();
                    let allowed = match &source_lane_id {
                        Some(sid) => find_lane(&proj, sid).map(|(_, l)| l.role == "melody").unwrap_or(false),
                        None => true,
                    };
                    if allowed {
                        if let Some(l) = find_lane_mut(&mut proj, &lane_id) {
                            l.keytrack_source_lane_id = source_lane_id;
                        }
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // ── MIDI-Learn (Startbildschirm) ──
        "learn.start" => {
            state
                .learn_armed
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = state.events.send(serde_json::json!({ "t": "learn.armed", "armed": true }));
        }
        "learn.cancel" => {
            state
                .learn_armed
                .store(false, std::sync::atomic::Ordering::Relaxed);
            let _ = state.events.send(serde_json::json!({ "t": "learn.armed", "armed": false }));
        }
        // Linkt ein gelerntes Keyboard-Control live an eine Melodie-Lane
        // (siehe `AppState::forward_to_recorder` / `ClockCommand::RecordNoteIn`).
        // Erneuter Aufruf mit denselben Werten hebt die Zuordnung wieder auf.
        "record.arm" => {
            if let (Some(control_id), Some(lane_id)) =
                (str_field(&cmd, "controlId"), str_field(&cmd, "laneId"))
            {
                let channel = {
                    let proj = state.project.lock().unwrap();
                    find_control(&proj, &control_id).and_then(|c| {
                        let m = c.get("mapping")?;
                        if m.get("kind").and_then(|v| v.as_str()) != Some("note") {
                            return None;
                        }
                        m.get("channel").and_then(|v| v.as_u64()).map(|v| v as u8)
                    })
                };
                let Some(channel) = channel else {
                    tracing::debug!("record.arm: Control „{control_id}“ hat kein Note-Mapping");
                    return;
                };
                let mut armed = state.record_armed.lock().unwrap();
                let now_armed = match &*armed {
                    Some(a) if a.control_id == control_id && a.lane_id == lane_id => {
                        *armed = None;
                        None
                    }
                    _ => {
                        let arm = crate::state::RecordArm { control_id: control_id.clone(), lane_id: lane_id.clone(), channel };
                        *armed = Some(arm);
                        Some((control_id, lane_id))
                    }
                };
                drop(armed);
                let _ = state.events.send(serde_json::json!({
                    "t": "record.armState",
                    "controlId": now_armed.as_ref().map(|(c, _)| c),
                    "laneId": now_armed.as_ref().map(|(_, l)| l),
                }));
            }
        }
        // Melodie-Editor: Piano-Rolle auf Eingabe schalten. Solange ein Baustein
        // armiert ist, meldet der MIDI-Eingangs-Thread jede Note als
        // `noteInput.note` an die UI (s. `AppState::forward_note_input`) und
        // spielt sie auf dem Ziel des Bausteins mit. `blockId: null` (oder ein
        // Wechsel auf einen anderen Baustein) entwaffnet.
        "noteInput.listen" => {
            set_note_input(state, str_field(&cmd, "blockId").as_deref());
        }
        "control.assignName" => {
            if let (Some(id), Some(name)) =
                (str_field(&cmd, "controlId"), str_field(&cmd, "name"))
            {
                state.rename_control(&id, &name);
                broadcast_snapshot(state);
            }
        }
        "control.move" => {
            if let (Some(id), Some(x), Some(y)) = (
                str_field(&cmd, "controlId"),
                cmd.get("x").and_then(|v| v.as_f64()),
                cmd.get("y").and_then(|v| v.as_f64()),
            ) {
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(c) = find_control_mut(&mut proj, &id) {
                        c["x"] = serde_json::json!(x);
                        c["y"] = serde_json::json!(y);
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // Dashboard-Control an einen Lane-Slot binden: eine passende eingehende
        // Note löst dann diesen Slot aus (s. `handle_midi_feedback`). `laneId`
        // oder `slotId` fehlt/null → Bindung entfernen.
        "control.setTrigger" => {
            if let Some(id) = str_field(&cmd, "controlId") {
                let lane = str_field(&cmd, "laneId");
                let slot = str_field(&cmd, "slotId");
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(c) = find_control_mut(&mut proj, &id) {
                        match (lane, slot) {
                            (Some(l), Some(s)) => {
                                c["trigger"] =
                                    serde_json::json!({ "laneId": l, "slotId": s, "enabled": true });
                            }
                            _ => {
                                if let Some(o) = c.as_object_mut() {
                                    o.remove("trigger");
                                }
                            }
                        }
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // Trigger-Bindung scharf/aus schalten, ohne sie zu entfernen.
        "control.setTriggerEnabled" => {
            if let (Some(id), Some(on)) = (
                str_field(&cmd, "controlId"),
                cmd.get("enabled").and_then(|v| v.as_bool()),
            ) {
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(c) = find_control_mut(&mut proj, &id) {
                        if let Some(t) = c.get_mut("trigger").and_then(|t| t.as_object_mut()) {
                            t.insert("enabled".to_string(), serde_json::json!(on));
                        }
                    }
                }
                broadcast_snapshot(state);
            }
        }
        "control.setSize" => {
            if let (Some(id), Some(w), Some(h)) = (
                str_field(&cmd, "controlId"),
                cmd.get("w").and_then(|v| v.as_f64()),
                cmd.get("h").and_then(|v| v.as_f64()),
            ) {
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(c) = find_control_mut(&mut proj, &id) {
                        c["w"] = serde_json::json!(w.clamp(60.0, 400.0));
                        c["h"] = serde_json::json!(h.clamp(60.0, 400.0));
                    }
                }
                broadcast_snapshot(state);
            }
        }
        "control.setDevice" => {
            if let Some(id) = str_field(&cmd, "controlId") {
                let device_id = str_field(&cmd, "deviceId");
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(c) = find_control_mut(&mut proj, &id) {
                        c["deviceId"] = match &device_id {
                            Some(d) => serde_json::json!(d),
                            None => serde_json::Value::Null,
                        };
                    }
                }
                broadcast_snapshot(state);
            }
        }
        "control.delete" => {
            if let Some(id) = str_field(&cmd, "controlId") {
                {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(arr) = proj.controls.as_array_mut() {
                        arr.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // Dashboard-Taster OHNE MIDI: schaltet eine Lane scharf/stumm
        // (`lane.enabled`) — wie der ▶/■-Knopf der Sequencer-Übersicht, nur
        // frei auf dem Dashboard plazierbar. Kein Mapping, kein MIDI-Ausgang;
        // das Umschalten selbst läuft weiter über `lane.setEnabled`.
        "control.addLaneToggle" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                let mut proj = state.project.lock().unwrap();
                let name = proj
                    .devices
                    .iter()
                    .flat_map(|d| d.lanes.iter())
                    .find(|l| l.id == lane_id)
                    .map(|l| l.name.clone());
                if let Some(name) = name {
                    const SIZE: f64 = 78.0;
                    let (x, y) = crate::state::next_free_position(&proj, SIZE);
                    let ctrl = serde_json::json!({
                        "id": uuid::Uuid::new_v4().to_string(),
                        "name": name,
                        "kind": "laneButton",
                        "laneToggle": { "laneId": lane_id },
                        "screenId": "main",
                        "x": x,
                        "y": y,
                        "w": SIZE,
                        "h": SIZE,
                    });
                    if !proj.controls.is_array() {
                        proj.controls = serde_json::json!([]);
                    }
                    proj.controls.as_array_mut().unwrap().push(ctrl);
                    drop(proj);
                    broadcast_snapshot(state);
                }
            }
        }
        "control.press" => {
            if let Some(id) = str_field(&cmd, "controlId") {
                let proj = state.project.lock().unwrap();
                if let Some((port, bytes)) = control_trigger(&proj, &id, true) {
                    if !has_device(&proj, &id) {
                        warn_no_device(state, &id);
                    }
                    state.clock.send(ClockCommand::Midi(port, bytes));
                }
            }
        }
        "control.release" => {
            if let Some(id) = str_field(&cmd, "controlId") {
                let proj = state.project.lock().unwrap();
                if let Some((port, bytes)) = control_trigger(&proj, &id, false) {
                    state.clock.send(ClockCommand::Midi(port, bytes));
                }
            }
        }
        "control.setKind" => {
            if let (Some(id), Some(kind)) = (str_field(&cmd, "controlId"), str_field(&cmd, "kind")) {
                let mut proj = state.project.lock().unwrap();
                if let Some(c) = find_control_mut(&mut proj, &id) {
                    c["kind"] = serde_json::json!(kind);
                    // "keyboard": kein einzelner Taster, sondern die Aktivität
                    // des GANZEN physischen Keyboards — Mapping auf "jede Note
                    // auf diesem Kanal" weiten, statt an der einen beim Lernen
                    // zufällig gedrückten Taste hängen zu bleiben.
                    if kind == "keyboard" {
                        if let Some(m) = c.get_mut("mapping").and_then(|m| m.as_object_mut()) {
                            if m.get("kind").and_then(|v| v.as_str()) == Some("note") {
                                m.remove("number");
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "control.setValue" => {
            if let (Some(id), Some(value)) = (
                str_field(&cmd, "controlId"),
                cmd.get("value").and_then(|v| v.as_u64()),
            ) {
                let value = value.min(127) as u8;
                let mut proj = state.project.lock().unwrap();
                if let Some(c) = find_control_mut(&mut proj, &id) {
                    c["value"] = serde_json::json!(value);
                }
                match control_cc(&proj, &id) {
                    Some((port, ch, num)) => {
                        if !has_device(&proj, &id) {
                            warn_no_device(state, &id);
                        }
                        state
                            .clock
                            .send(ClockCommand::Midi(port, vec![0xB0 | (ch - 1), num, value]));
                    }
                    None => warn_no_mapping(state, &id),
                }
            }
        }
        // ── Lane-Controls (Schnellbedienung: Drum-Buttons, Macro-Knobs, …) ──
        "laneControl.add" => {
            if let (Some(lane_id), Some(mut control)) =
                (str_field(&cmd, "laneId"), cmd.get("control").cloned())
            {
                let mut proj = state.project.lock().unwrap();
                // Ein Macro-Knob fernsteuert einen gelernten Knob DIESES Devices
                // (s. `lane_control_set_value`) — ein anderes Ziel wäre nicht
                // verbunden und würde beim Ziehen ins Leere senden.
                let macro_ok = control.get("kind").and_then(|v| v.as_str()) != Some("macroKnob")
                    || control
                        .get("controlId")
                        .and_then(|v| v.as_str())
                        .is_some_and(|cid| lane_can_target_control(&proj, &lane_id, cid));
                if macro_ok {
                    if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                        if !lane.controls.is_array() {
                            lane.controls = serde_json::json!([]);
                        }
                        let order = lane.controls.as_array().map(|a| a.len()).unwrap_or(0);
                        control["id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
                        control["order"] = serde_json::json!(order);
                        lane.controls.as_array_mut().unwrap().push(control);
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "laneControl.update" => {
            if let (Some(lane_id), Some(control_id), Some(patch)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "controlId"),
                cmd.get("patch").cloned(),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(c) = find_lane_control_mut(lane, &control_id) {
                        if let (Some(obj), Some(patch_obj)) = (c.as_object_mut(), patch.as_object()) {
                            for (k, v) in patch_obj {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "laneControl.remove" => {
            if let (Some(lane_id), Some(control_id)) =
                (str_field(&cmd, "laneId"), str_field(&cmd, "controlId"))
            {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(arr) = lane.controls.as_array_mut() {
                        arr.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(control_id.as_str()));
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "laneControl.press" => {
            if let (Some(lane_id), Some(control_id)) =
                (str_field(&cmd, "laneId"), str_field(&cmd, "controlId"))
            {
                lane_control_trigger(state, &lane_id, &control_id, true);
            }
        }
        "laneControl.release" => {
            if let (Some(lane_id), Some(control_id)) =
                (str_field(&cmd, "laneId"), str_field(&cmd, "controlId"))
            {
                lane_control_trigger(state, &lane_id, &control_id, false);
            }
        }
        "laneControl.setValue" => {
            if let (Some(lane_id), Some(control_id), Some(value)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "controlId"),
                cmd.get("value").and_then(|v| v.as_u64()),
            ) {
                lane_control_set_value(state, &lane_id, &control_id, value.min(127) as u8);
            }
        }
        "block.trigger" => {
            if let (Some(lane_id), Some(slot_id)) =
                (str_field(&cmd, "laneId"), str_field(&cmd, "slotId"))
            {
                state.clock.send(ClockCommand::TriggerSlot(lane_id, slot_id, None));
            }
        }
        "block.press" => {
            if let (Some(lane_id), Some(slot_id)) =
                (str_field(&cmd, "laneId"), str_field(&cmd, "slotId"))
            {
                state.clock.send(ClockCommand::PressSlot(lane_id, slot_id, None));
            }
        }
        "block.release" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                state.clock.send(ClockCommand::ReleaseSlot(lane_id));
            }
        }
        "block.rename" => {
            if let (Some(id), Some(name)) = (str_field(&cmd, "blockId"), str_field(&cmd, "name")) {
                let name: String = name.chars().take(6).collect();
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    b["name"] = serde_json::json!(name);
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Bibliothek: legt einen neuen Baustein direkt an einer
        // gewählten (row, col) im 9×9-Raster an (Baustein-Bibliothek-Screen,
        // im Unterschied zu `lane.addBlock`, das die nächste freie Zelle nimmt).
        // No-op, wenn die Zelle schon belegt ist.
        "block.createAt" => {
            if let (Some(block_type), Some(row), Some(col)) = (
                str_field(&cmd, "blockType"),
                cmd.get("row").and_then(|v| v.as_u64()),
                cmd.get("col").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                let occupied = proj.blocks.as_array().map(|arr| {
                    arr.iter().any(|b| {
                        b.get("type").and_then(|v| v.as_str()) == Some(block_type.as_str())
                            && b.get("slot").and_then(|s| s.get("row")).and_then(|v| v.as_u64()) == Some(row)
                            && b.get("slot").and_then(|s| s.get("col")).and_then(|v| v.as_u64()) == Some(col)
                    })
                }).unwrap_or(false);
                if !occupied {
                    if let Some(mut block) = default_block_for(&block_type) {
                        block["slot"] = serde_json::json!({ "type": block_type, "row": row, "col": col });
                        if let Some(arr) = proj.blocks.as_array_mut() {
                            arr.push(block);
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Bibliothek: entfernt einen Baustein endgültig und räumt
        // dangling Lane-Slot-Referenzen in ALLEN Lanes ALLER Devices auf.
        "block.delete" => {
            if let Some(id) = str_field(&cmd, "blockId") {
                let mut proj = state.project.lock().unwrap();
                if let Some(arr) = proj.blocks.as_array_mut() {
                    arr.retain(|b| b.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
                }
                for d in proj.devices.iter_mut() {
                    for lane in d.lanes.iter_mut() {
                        if let Some(slots) = lane.slots.as_array_mut() {
                            slots.retain(|s| s.get("blockId").and_then(|v| v.as_str()) != Some(id.as_str()));
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Bibliothek: verschiebt einen bestehenden Baustein auf eine
        // andere (row, col) im 9×9-Raster seines Typs — no-op, wenn die
        // Zielzelle schon von einem ANDEREN Baustein belegt ist.
        "block.move" => {
            if let (Some(id), Some(row), Some(col)) = (
                str_field(&cmd, "blockId"),
                cmd.get("row").and_then(|v| v.as_u64()),
                cmd.get("col").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                let block_type = proj
                    .blocks
                    .as_array()
                    .and_then(|arr| arr.iter().find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
                    .and_then(|b| b.get("type").and_then(|v| v.as_str()))
                    .map(str::to_string);
                if let Some(block_type) = block_type {
                    let occupied_by_other = proj.blocks.as_array().map(|arr| {
                        arr.iter().any(|b| {
                            b.get("id").and_then(|v| v.as_str()) != Some(id.as_str())
                                && b.get("type").and_then(|v| v.as_str()) == Some(block_type.as_str())
                                && b.get("slot").and_then(|s| s.get("row")).and_then(|v| v.as_u64()) == Some(row)
                                && b.get("slot").and_then(|s| s.get("col")).and_then(|v| v.as_u64()) == Some(col)
                        })
                    }).unwrap_or(false);
                    if !occupied_by_other {
                        if let Some(b) = proj.blocks.as_array_mut().and_then(|arr| {
                            arr.iter_mut().find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                        }) {
                            b["slot"] = serde_json::json!({ "type": block_type, "row": row, "col": col });
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Generischer Skalarfeld-Setter für Baustein-Felder, die keine
        // strukturelle Array-Logik brauchen (Kanal-Override, sourceControlId,
        // baseNote, direction, gateSteps, rateSteps, velocity, …).
        // `value: null` löscht das Feld (z.B. Kanal-Override zurücksetzen).
        "block.setField" => {
            if let (Some(id), Some(field)) = (str_field(&cmd, "blockId"), str_field(&cmd, "field"))
            {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    match cmd.get("value") {
                        Some(serde_json::Value::Null) | None => {
                            if let Some(obj) = b.as_object_mut() {
                                obj.remove(&field);
                            }
                        }
                        Some(v) => b[field] = v.clone(),
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Raster: Länge in Takten und/oder Auflösung (Substeps pro
        // Takt) ändern. Beides sitzt am Baustein selbst (BlockBase), gilt also
        // für jede Lane, in der er steckt. Der Inhalt wandert mit — sonst
        // stünden nach einem Auflösungswechsel alle Noten auf der falschen Zeit
        // und die neuen Steps wären nicht bespielbar (`beat.toggleStep` /
        // `cc.setStepValue` fassen nur vorhandene Array-Indizes an).
        "block.setLength" => {
            if let Some(id) = str_field(&cmd, "blockId") {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    let old_spb = block_u32(b, "stepsPerBar", 16).max(1);
                    let old_bars = block_u32(b, "lengthBars", 1).max(1);
                    let new_spb = cmd
                        .get("stepsPerBar")
                        .and_then(|v| v.as_u64())
                        .map(|v| (v as u32).clamp(MIN_STEPS_PER_BAR, MAX_STEPS_PER_BAR))
                        .unwrap_or(old_spb);
                    let new_bars = cmd
                        .get("lengthBars")
                        .and_then(|v| v.as_u64())
                        .map(|v| (v as u32).clamp(1, MAX_LENGTH_BARS))
                        .unwrap_or(old_bars);
                    if (new_spb, new_bars) != (old_spb, old_bars) {
                        b["stepsPerBar"] = serde_json::json!(new_spb);
                        b["lengthBars"] = serde_json::json!(new_bars);
                        refit_block_content(b, old_spb, new_spb, new_spb * new_bars);
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: neue Note an einem Step hinzufügen. Ein Step kann
        // mehrere gleichzeitige Noten tragen (Akkord-Stack im Melodie-Editor,
        // wächst per "+" nach unten) — Engine/`fire_step` feuert ohnehin schon
        // alle Noten mit gleichem `step` zusammen. Adressiert wird eine Note
        // über (step, Tonhöhe); ein Duplikat an derselben Tonhöhe wird ignoriert.
        "melody.addNote" => {
            if let (Some(id), Some(step), Some(note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let note = note.min(127);
                // Anschlag und Länge dürfen mitkommen — beim Einspielen über
                // die Piano-Rolle (`noteInput`) stehen beide schon fest, und
                // drei Kommandos je gespielter Note wären drei Snapshots.
                let velocity = cmd
                    .get("velocity")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.clamp(1, 127));
                let length = cmd
                    .get("lengthSteps")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.max(1));
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["notes"].is_array() {
                        b["notes"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["notes"].as_array_mut() {
                        let existing = arr.iter_mut().find(|n| {
                            n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(note)
                        });
                        match existing {
                            // Dieselbe Tonhöhe am selben Step noch einmal
                            // gespielt: kein zweiter Eintrag (die Note gibt es
                            // nur einmal), aber mitgeschickter Anschlag/Länge
                            // schreiben die vorhandene um — beim Einspielen ist
                            // das erneute Anschlagen genau diese Absicht.
                            Some(n) => {
                                if let Some(v) = velocity {
                                    n["velocity"] = serde_json::json!(v);
                                }
                                if let Some(l) = length {
                                    n["lengthSteps"] = serde_json::json!(l);
                                }
                            }
                            None => arr.push(serde_json::json!({
                                "step": step,
                                "lengthSteps": length.unwrap_or(1),
                                "note": note,
                                "velocity": velocity.unwrap_or(100),
                            })),
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: eine bestimmte Note an einem Step entfernen (Step
        // kann mehrere Noten haben — identifiziert über step+Tonhöhe).
        "melody.removeNote" => {
            if let (Some(id), Some(step), Some(note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["notes"].as_array_mut() {
                        arr.retain(|n| {
                            !(n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(note))
                        });
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: ALLE Noten dieses Bausteins auf einen Schlag
        // entfernen (die UI fragt vorher nach — das hier räumt ohne Rückfrage).
        "melody.clear" => {
            if let Some(id) = str_field(&cmd, "blockId") {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    b["notes"] = serde_json::json!([]);
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: Tonhöhe einer bestehenden Note am Step ändern
        // (identifiziert über die bisherige Tonhöhe). No-op, wenn die Ziel-
        // Tonhöhe am selben Step schon durch eine andere Note belegt ist.
        "melody.setNotePitch" => {
            if let (Some(id), Some(step), Some(note), Some(new_note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
                cmd.get("newNote").and_then(|v| v.as_u64()),
            ) {
                let new_note = new_note.min(127);
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["notes"].as_array_mut() {
                        let collision = arr.iter().any(|n| {
                            n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(new_note)
                        });
                        if !collision {
                            if let Some(n) = arr.iter_mut().find(|n| {
                                n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                    && n.get("note").and_then(|v| v.as_u64()) == Some(note)
                            }) {
                                n["note"] = serde_json::json!(new_note);
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: Dauer (in Steps) einer bestimmten Note am Step
        // ändern — z.B. für gehaltene Pad-/Bass-Noten statt nur kurzer
        // Stakkato-Hits (identifiziert über step+Tonhöhe).
        "melody.setNoteLength" => {
            if let (Some(id), Some(step), Some(note), Some(len)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
                cmd.get("lengthSteps").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["notes"].as_array_mut() {
                        if let Some(n) = arr.iter_mut().find(|n| {
                            n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(note)
                        }) {
                            n["lengthSteps"] = serde_json::json!(len.clamp(1, 512));
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: Anschlagstärke einer bestimmten Note am Step
        // (identifiziert über step+Tonhöhe). Untergrenze 1, nicht 0: eine Note
        // mit Velocity 0 IST auf dem Draht ein Note-Off — sie würde gar nicht
        // klingen, und zum Entfernen gibt es `melody.removeNote`.
        "melody.setNoteVelocity" => {
            if let (Some(id), Some(step), Some(note), Some(vel)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
                cmd.get("velocity").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["notes"].as_array_mut() {
                        if let Some(n) = arr.iter_mut().find(|n| {
                            n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(note)
                        }) {
                            n["velocity"] = serde_json::json!(vel.clamp(1, 127));
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Detail: eine Tonhöhe live anspielen (Klaviatur am Rand der
        // Piano-Rolle). Läuft — wie die Live-Controls — an der Engine vorbei
        // direkt auf den Port, verändert also NICHTS am Projekt: kein
        // Snapshot, kein Autosave, nur Note-On/Note-Off.
        "block.previewNote" => {
            if let (Some(id), Some(note), Some(on)) = (
                str_field(&cmd, "blockId"),
                cmd.get("note").and_then(|v| v.as_u64()),
                cmd.get("on").and_then(|v| v.as_bool()),
            ) {
                let note = note.min(127) as u8;
                let vel = cmd
                    .get("velocity")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(100)
                    .clamp(1, 127) as u8;
                let proj = state.project.lock().unwrap();
                if let Some((port, ch)) = block_preview_target(&proj, &id) {
                    let bytes = if on {
                        vec![0x90 | (ch - 1), note, vel]
                    } else {
                        vec![0x80 | (ch - 1), note, 0]
                    };
                    state.clock.send(ClockCommand::Midi(port, bytes));
                }
            }
        }
        // Baustein-Detail: „▶ Play" — den offenen Baustein einmal oder in
        // Schleife abspielen, unabhängig vom Transport und ohne dass er in
        // einer Lane stecken muss (s. `Engine::start_block_preview`).
        "block.play" => {
            if let Some(id) = str_field(&cmd, "blockId") {
                let looping = cmd.get("loop").and_then(|v| v.as_bool()).unwrap_or(false);
                state.clock.send(ClockCommand::PlayBlockPreview(id, looping));
            }
        }
        // „■ Stop" bzw. Editor geschlossen: eine laufende Baustein-Vorschau
        // sofort beenden.
        "block.stopPreview" => {
            state.clock.send(ClockCommand::StopBlockPreview);
        }
        // Baustein-Detail: Step einer Beat-Line an/aus (velocity 0/100).
        "beat.toggleStep" => {
            if let (Some(id), Some(line_id), Some(step)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "lineId"),
                cmd.get("step").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(line) = find_beat_line_mut(b, &line_id) {
                        if let Some(s) = line["steps"].as_array_mut().and_then(|a| a.get_mut(step as usize)) {
                            let on = s.get("velocity").and_then(|v| v.as_u64()).unwrap_or(0) > 0;
                            s["velocity"] = serde_json::json!(if on { 0 } else { 100 });
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "beat.setLineMuted" => {
            if let (Some(id), Some(line_id), Some(muted)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "lineId"),
                cmd.get("muted").and_then(|v| v.as_bool()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(line) = find_beat_line_mut(b, &line_id) {
                        line["muted"] = serde_json::json!(muted);
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Welche MIDI-Note diese Drum-Line schickt (0–127). Der Engine-Zweig für
        // Beat liest `line.note` direkt (s. `compile_block`), also reicht das
        // Umschreiben im Projekt.
        "beat.setLineNote" => {
            if let (Some(id), Some(line_id), Some(note)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "lineId"),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(line) = find_beat_line_mut(b, &line_id) {
                        line["note"] = serde_json::json!(note.min(127));
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Chord-Detail: Note bei (step, note) im Akkord an diesem Step an/aus.
        // Gleiches Piano-Roll-Grid wie Melodie, aber mehrere Noten pro Step
        // (ChordEvent.notes) statt einzelner MelodyNote-Einträge.
        "chord.toggleNote" => {
            if let (Some(id), Some(step), Some(note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["chords"].is_array() {
                        b["chords"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["chords"].as_array_mut() {
                        let idx = arr.iter().position(|c| c.get("step").and_then(|v| v.as_u64()) == Some(step));
                        if let Some(i) = idx {
                            let notes = arr[i]["notes"].as_array_mut().unwrap();
                            let ni = notes.iter().position(|n| n.as_u64() == Some(note));
                            match ni {
                                Some(j) => {
                                    notes.remove(j);
                                }
                                None => notes.push(serde_json::json!(note)),
                            }
                            if arr[i]["notes"].as_array().map(|a| a.is_empty()).unwrap_or(false) {
                                arr.remove(i);
                            }
                        } else {
                            arr.push(serde_json::json!({
                                "step": step,
                                "lengthSteps": 1,
                                "notes": [note],
                                "velocity": 100,
                            }));
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Arp-Detail: Note im Notenvorrat (chordNotes) an/aus.
        "arp.toggleNote" => {
            if let (Some(id), Some(note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["chordNotes"].is_array() {
                        b["chordNotes"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["chordNotes"].as_array_mut() {
                        let idx = arr.iter().position(|n| n.as_u64() == Some(note));
                        match idx {
                            Some(i) => {
                                arr.remove(i);
                            }
                            None => arr.push(serde_json::json!(note)),
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // CC-Detail: Layer-Verwaltung (mehrere Layer, "von unten nach oben
        // kombiniert" — LFO/Envelope/Ramp/Random/Stepped, siehe CcLayer im
        // Modell). Werte in Layern sind IMMER 0..1 normiert (nicht 0-127) —
        // die endgültige Skalierung auf outMin..outMax passiert erst beim
        // Zusammensetzen der Layer (Engine, folgt später).
        "cc.addLayer" => {
            if let (Some(id), Some(kind)) = (str_field(&cmd, "blockId"), str_field(&cmd, "kind")) {
                let steps = cmd.get("steps").and_then(|v| v.as_u64()).unwrap_or(16) as usize;
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["layers"].is_array() {
                        b["layers"] = serde_json::json!([]);
                    }
                    if let Some(layer) = default_cc_layer(&kind, steps) {
                        if let Some(arr) = b["layers"].as_array_mut() {
                            arr.push(layer);
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "cc.removeLayer" => {
            if let (Some(id), Some(layer_id)) = (str_field(&cmd, "blockId"), str_field(&cmd, "layerId")) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["layers"].as_array_mut() {
                        arr.retain(|l| l.get("id").and_then(|v| v.as_str()) != Some(layer_id.as_str()));
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "cc.moveLayer" => {
            if let (Some(id), Some(layer_id), Some(dir)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "layerId"),
                str_field(&cmd, "dir"),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(arr) = b["layers"].as_array_mut() {
                        if let Some(i) = arr.iter().position(|l| l.get("id").and_then(|v| v.as_str()) == Some(layer_id.as_str())) {
                            let j = if dir == "up" { i.checked_sub(1) } else { (i + 1 < arr.len()).then_some(i + 1) };
                            if let Some(j) = j {
                                arr.swap(i, j);
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Patcht beliebige Skalarfelder eines Layers (enabled/combine/depth/
        // offset/waveform/rateBars/phase/from/to/everySteps/smooth, …).
        "cc.updateLayer" => {
            if let (Some(id), Some(layer_id), Some(patch)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "layerId"),
                cmd.get("patch").cloned(),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(layer) = find_cc_layer_mut(b, &layer_id) {
                        if let (Some(obj), Some(patch_obj)) = (layer.as_object_mut(), patch.as_object()) {
                            for (k, v) in patch_obj {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "cc.setStepValue" => {
            if let (Some(id), Some(layer_id), Some(step), Some(value)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "layerId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("value").and_then(|v| v.as_f64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(layer) = find_cc_layer_mut(b, &layer_id) {
                        if let Some(values) = layer["values"].as_array_mut() {
                            if let Some(slot) = values.get_mut(step as usize) {
                                *slot = serde_json::json!(value.clamp(0.0, 1.0));
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Envelope-Layer: Punkt bei `step` anlegen/ändern/löschen (value=null → löschen).
        "cc.setEnvelopePoint" => {
            if let (Some(id), Some(layer_id), Some(step)) = (
                str_field(&cmd, "blockId"),
                str_field(&cmd, "layerId"),
                cmd.get("step").and_then(|v| v.as_u64()),
            ) {
                let value = cmd.get("value").and_then(|v| v.as_f64());
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(layer) = find_cc_layer_mut(b, &layer_id) {
                        if !layer["points"].is_array() {
                            layer["points"] = serde_json::json!([]);
                        }
                        if let Some(arr) = layer["points"].as_array_mut() {
                            let idx = arr.iter().position(|p| p.get("step").and_then(|v| v.as_u64()) == Some(step));
                            match (idx, value) {
                                (Some(i), Some(v)) => arr[i]["value"] = serde_json::json!(v.clamp(0.0, 1.0)),
                                (Some(i), None) => {
                                    arr.remove(i);
                                }
                                (None, Some(v)) => arr.push(serde_json::json!({ "step": step, "value": v.clamp(0.0, 1.0) })),
                                (None, None) => {}
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // ProgramChange-Detail: Event bei `step` anlegen/ändern/löschen (program=null → löschen).
        "programChange.setEvent" => {
            if let (Some(id), Some(step)) =
                (str_field(&cmd, "blockId"), cmd.get("step").and_then(|v| v.as_u64()))
            {
                let program = cmd.get("program").and_then(|v| v.as_u64());
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["events"].is_array() {
                        b["events"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["events"].as_array_mut() {
                        let idx = arr.iter().position(|e| e.get("atStep").and_then(|v| v.as_u64()) == Some(step));
                        match (idx, program) {
                            (Some(i), Some(p)) => arr[i]["program"] = serde_json::json!(p.min(127)),
                            (Some(i), None) => {
                                arr.remove(i);
                            }
                            (None, Some(p)) => arr.push(serde_json::json!({ "atStep": step, "program": p.min(127) })),
                            (None, None) => {}
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // PatternShift-Detail: Nachricht bei `step` anlegen/ändern/löschen (kind=null → löschen).
        "patternShift.setEvent" => {
            if let (Some(id), Some(step)) =
                (str_field(&cmd, "blockId"), cmd.get("step").and_then(|v| v.as_u64()))
            {
                let kind = str_field(&cmd, "kind");
                let data1 = cmd.get("data1").and_then(|v| v.as_u64());
                let data2 = cmd.get("data2").and_then(|v| v.as_u64());
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["messages"].is_array() {
                        b["messages"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["messages"].as_array_mut() {
                        let idx = arr.iter().position(|m| m.get("atStep").and_then(|v| v.as_u64()) == Some(step));
                        match (idx, &kind) {
                            (Some(i), Some(k)) => {
                                arr[i]["kind"] = serde_json::json!(k);
                                arr[i]["data1"] = serde_json::json!(data1.unwrap_or(0).min(127));
                                if let Some(d2) = data2 {
                                    arr[i]["data2"] = serde_json::json!(d2.min(127));
                                } else if let Some(o) = arr[i].as_object_mut() {
                                    o.remove("data2");
                                }
                            }
                            (Some(i), None) => {
                                arr.remove(i);
                            }
                            (None, Some(k)) => {
                                let mut msg = serde_json::json!({
                                    "atStep": step,
                                    "kind": k,
                                    "data1": data1.unwrap_or(0).min(127),
                                });
                                if let Some(d2) = data2 {
                                    msg["data2"] = serde_json::json!(d2.min(127));
                                }
                                arr.push(msg);
                            }
                            (None, None) => {}
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "lane.addBlock" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                {
                    let mut proj = state.project.lock().unwrap();
                    let role = proj.devices.iter().find_map(|d| {
                        d.lanes
                            .iter()
                            .find(|l| l.id == lane_id)
                            .map(|l| l.role.clone())
                    });
                    if let Some(role) = role {
                        if let Some(mut block) = default_block_for(&role) {
                            if let Some((row, col)) = next_free_slot(&proj.blocks, &role) {
                                block["slot"] =
                                    serde_json::json!({ "type": role, "row": row, "col": col });
                                let bid = block
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                if let Some(arr) = proj.blocks.as_array_mut() {
                                    arr.push(block);
                                }
                                for d in proj.devices.iter_mut() {
                                    if let Some(l) = d.lanes.iter_mut().find(|l| l.id == lane_id) {
                                        if let Some(sl) = l.slots.as_array_mut() {
                                            sl.push(demo_slot(&bid));
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                broadcast_snapshot(state);
            }
        }
        // Fügt einen BESTEHENDEN Baustein aus der projektweiten Bibliothek als
        // neuen Slot in eine Lane ein — anders als `lane.addBlock`, das immer
        // einen frischen Baustein anlegt. Nur erlaubt, wenn Baustein-Typ und
        // Lane-Rolle übereinstimmen.
        "laneSlot.add" => {
            if let (Some(lane_id), Some(block_id)) = (str_field(&cmd, "laneId"), str_field(&cmd, "blockId")) {
                let mut proj = state.project.lock().unwrap();
                let role = proj.devices.iter().find_map(|d| {
                    d.lanes
                        .iter()
                        .find(|l| l.id == lane_id)
                        .map(|l| l.role.clone())
                });
                if let Some(role) = role {
                    let block_matches = proj
                        .blocks
                        .as_array()
                        .map(|arr| {
                            arr.iter().any(|b| {
                                b.get("id").and_then(|v| v.as_str()) == Some(block_id.as_str())
                                    && b.get("type").and_then(|v| v.as_str()) == Some(role.as_str())
                            })
                        })
                        .unwrap_or(false);
                    if block_matches {
                        for d in proj.devices.iter_mut() {
                            if let Some(l) = d.lanes.iter_mut().find(|l| l.id == lane_id) {
                                if let Some(sl) = l.slots.as_array_mut() {
                                    sl.push(demo_slot(&block_id));
                                }
                                break;
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Per-Slot-Felder — jede Lane kann denselben Baustein mehrfach mit
        // unterschiedlichem Transpose/Speed/Loop einsetzen, daher hängen
        // diese drei am Slot (laneId+slotId), nicht am Baustein selbst.
        "block.setTranspose" => {
            if let (Some(lane_id), Some(slot_id), Some(transpose)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "slotId"),
                cmd.get("transpose").and_then(|v| v.as_i64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(arr) = lane.slots.as_array_mut() {
                        if let Some(slot) = arr.iter_mut().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(slot_id.as_str())) {
                            slot["transpose"] = serde_json::json!(transpose);
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "block.setSpeed" => {
            if let (Some(lane_id), Some(slot_id), Some(speed)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "slotId"),
                cmd.get("speed").and_then(|v| v.as_f64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(arr) = lane.slots.as_array_mut() {
                        if let Some(slot) = arr.iter_mut().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(slot_id.as_str())) {
                            slot["speed"] = serde_json::json!(speed);
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "block.setLoop" => {
            if let (Some(lane_id), Some(slot_id), Some(loop_mode)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "slotId"),
                str_field(&cmd, "loop"),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(arr) = lane.slots.as_array_mut() {
                        if let Some(slot) = arr.iter_mut().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(slot_id.as_str())) {
                            slot["loopMode"] = serde_json::json!(loop_mode);
                            if let Some(count) = cmd.get("count").and_then(|v| v.as_i64()) {
                                slot["loopCount"] = serde_json::json!(count);
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Tauscht den Baustein eines bestehenden Slots aus — Slot-ID und
        // Slot-Felder (transpose/speed/loopMode) bleiben erhalten, nur
        // blockId wechselt. Gleiche Validierung wie laneSlot.add (Typ muss
        // zur Lane-Rolle passen).
        "laneSlot.setBlock" => {
            if let (Some(lane_id), Some(slot_id), Some(block_id)) = (
                str_field(&cmd, "laneId"),
                str_field(&cmd, "slotId"),
                str_field(&cmd, "blockId"),
            ) {
                let mut proj = state.project.lock().unwrap();
                let role = proj.devices.iter().find_map(|d| {
                    d.lanes
                        .iter()
                        .find(|l| l.id == lane_id)
                        .map(|l| l.role.clone())
                });
                if let Some(role) = role {
                    let block_matches = proj
                        .blocks
                        .as_array()
                        .map(|arr| {
                            arr.iter().any(|b| {
                                b.get("id").and_then(|v| v.as_str()) == Some(block_id.as_str())
                                    && b.get("type").and_then(|v| v.as_str()) == Some(role.as_str())
                            })
                        })
                        .unwrap_or(false);
                    if block_matches {
                        for d in proj.devices.iter_mut() {
                            if let Some(l) = d.lanes.iter_mut().find(|l| l.id == lane_id) {
                                if let Some(sl) = l.slots.as_array_mut() {
                                    if let Some(slot) = sl.iter_mut().find(|s| {
                                        s.get("id").and_then(|v| v.as_str()) == Some(slot_id.as_str())
                                    }) {
                                        slot["blockId"] = serde_json::json!(block_id);
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        "laneSlot.remove" => {
            if let (Some(lane_id), Some(slot_id)) = (str_field(&cmd, "laneId"), str_field(&cmd, "slotId")) {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if let Some(arr) = lane.slots.as_array_mut() {
                        arr.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(slot_id.as_str()));
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Bausteinkette einer Lane umsortieren (Kachel nach links/rechts
        // schieben). `orderedSlotIds` gibt die neue Reihenfolge vor; nicht
        // gelistete Slots hängen sich in bisheriger Reihenfolge hinten an.
        "laneSlot.reorder" => {
            if let Some(lane_id) = str_field(&cmd, "laneId") {
                let ordered: Vec<String> = cmd
                    .get("orderedSlotIds")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if !ordered.is_empty() {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                        if let Some(arr) = lane.slots.as_array_mut() {
                            let rank = |s: &serde_json::Value| -> usize {
                                s.get("id")
                                    .and_then(|v| v.as_str())
                                    .and_then(|id| ordered.iter().position(|o| o == id))
                                    .unwrap_or(usize::MAX)
                            };
                            arr.sort_by_key(rank);
                        }
                    }
                    drop(proj);
                    broadcast_snapshot(state);
                }
            }
        }
        // ── WLAN-Access-Point ──────────────────────────────────────────────
        "network.getState" => broadcast_network_state(state),
        "network.setAp" => {
            let enabled = cmd.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let ssid = cmd
                .get("ssid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let password = cmd
                .get("password")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let cfg = net_ap::NetworkConfig { ap_enabled: enabled, ssid, password };

            if let Err(msg) = net_ap::validate(&cfg) {
                let _ = state
                    .events
                    .send(serde_json::json!({ "t": "network.error", "message": msg }));
            } else if !net_ap::supported() {
                let _ = state.events.send(serde_json::json!({
                    "t": "network.error",
                    "message": "WLAN-Access-Point gibt es nur auf dem Pi.",
                }));
            } else {
                *state.network.lock().unwrap() = cfg.clone();
                if let Err(e) = net_ap::save(&state.data_dir, &cfg) {
                    tracing::warn!("network.json speichern fehlgeschlagen: {e}");
                }
                let events = state.events.clone();
                let port = server_port();
                // `nmcli` setzt die Schnittstelle neu auf (Sekunden) — im Task,
                // damit der Command-Loop weiterläuft. Ergebnis geht als
                // network.state (bzw. network.error) an alle Clients.
                tokio::spawn(async move {
                    let apply_cfg = cfg.clone();
                    let res = tokio::task::spawn_blocking(move || net_ap::apply(&apply_cfg))
                        .await
                        .unwrap_or_else(|e| Err(format!("Task abgebrochen: {e}")));
                    match res {
                        Ok(()) => {
                            let active = tokio::task::spawn_blocking(net_ap::status)
                                .await
                                .map(|(a, _)| a)
                                .unwrap_or(cfg.ap_enabled);
                            let _ = events.send(net_ap::state_event(&cfg, port, active));
                        }
                        Err(msg) => {
                            let _ = events.send(
                                serde_json::json!({ "t": "network.error", "message": msg }),
                            );
                            let _ = events.send(net_ap::state_event(&cfg, port, false));
                        }
                    }
                });
            }
        }
        other => {
            // Noch nicht implementierte Commands werden geloggt, aber ignoriert.
            tracing::debug!("Command (noch) nicht behandelt: {other}");
        }
    }
}

fn str_field(cmd: &serde_json::Value, key: &str) -> Option<String> {
    cmd.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Schickt die Liste aller gespeicherten Projekte (+ID des offenen) an alle
/// Clients — Grundlage des Projekt-Menüs hinter dem Zahnrad. Bewusst nur auf
/// Anfrage bzw. nach Projekt-Operationen statt in jedem Snapshot: dafür
/// müsste bei JEDER Änderung das Projektverzeichnis eingelesen werden.
fn broadcast_project_list(state: &AppState) {
    let projects = state.list_projects();
    let current_id = state.project.lock().unwrap().id.clone();
    let _ = state.events.send(serde_json::json!({
        "t": "project.list",
        "projects": projects,
        "currentId": current_id,
    }));
}

/// Wechselt das geöffnete Projekt.
///
/// Vorher wird die Wiedergabe gestoppt und ein Panic geschickt: die Engine
/// hält Noten und Slot-Positionen des ALTEN Projekts: ohne Stop liefen die
/// gehaltenen Noten weiter, ohne dass es die zugehörigen Bausteine noch gibt.
/// Ein per `record.arm` armiertes Aufnahmeziel zeigt aus demselben Grund auf
/// eine Lane, die es nicht mehr gibt, und wird ebenfalls gelöst.
///
/// `save_current` sichert das bisherige Projekt zuvor auf Platte — false nur,
/// wenn dessen Datei gerade absichtlich gelöscht wurde (`project.delete`).
fn switch_project(state: &AppState, proj: Project, save_current: bool) {
    if save_current {
        if let Err(e) = state.save_project() {
            tracing::warn!("Auto-Save vor Projektwechsel fehlgeschlagen: {e}");
        }
    }
    state.clock.send(ClockCommand::Stop);
    state.clock.send(ClockCommand::Panic);

    let bpm = proj.bpm;
    *state.project.lock().unwrap() = proj;
    state.clock.send(ClockCommand::SetBpm(bpm));

    *state.record_armed.lock().unwrap() = None;
    let _ = state.events.send(
        serde_json::json!({ "t": "record.armState", "controlId": null, "laneId": null }),
    );
    // Dasselbe für eine offene Piano-Roll-Eingabe: ihr Baustein gehört zum
    // alten Projekt.
    set_note_input(state, None);

    broadcast_snapshot(state); // legt das neue Projekt gleich auf Platte an
    broadcast_project_list(state);
}

fn broadcast_snapshot(state: &AppState) {
    state.bump_generation();
    let _ = state.events.send(state.snapshot_event());
    // Sicherheitsnetz: strukturelle Änderungen (Device/Control/Lane/…) landen
    // sofort auf Platte, damit ein Server-Neustart nichts verwirft. Häufige
    // Wert-Änderungen (CC-Ziehen, Note-Press) laufen NICHT hierüber.
    if let Err(e) = state.save_project() {
        tracing::warn!("Auto-Save fehlgeschlagen: {e}");
    }
}

fn with_device<F: FnMut(&mut Device)>(state: &AppState, device_id: &str, mut f: F) {
    {
        let mut proj = state.project.lock().unwrap();
        if let Some(d) = proj.devices.iter_mut().find(|d| d.id == device_id) {
            f(d);
        }
    }
    broadcast_snapshot(state);
}

fn with_lane<F: FnMut(&mut Lane)>(state: &AppState, lane_id: &str, mut f: F) {
    {
        let mut proj = state.project.lock().unwrap();
        for d in proj.devices.iter_mut() {
            if let Some(l) = d.lanes.iter_mut().find(|l| l.id == lane_id) {
                f(l);
                break;
            }
        }
    }
    broadcast_snapshot(state);
}

fn lane_bool<F: FnMut(&mut Lane, bool)>(
    state: &AppState,
    cmd: &serde_json::Value,
    key: &str,
    mut f: F,
) {
    if let (Some(id), Some(v)) = (str_field(cmd, "laneId"), cmd.get(key).and_then(|v| v.as_bool())) {
        with_lane(state, &id, |l| f(l, v));
    }
}

fn lane_str<F: FnMut(&mut Lane, String)>(
    state: &AppState,
    cmd: &serde_json::Value,
    key: &str,
    mut f: F,
) {
    if let (Some(id), Some(v)) = (str_field(cmd, "laneId"), str_field(cmd, key)) {
        with_lane(state, &id, |l| f(l, v.clone()));
    }
}

// ── Baustein-Helfer (Baustein-Detail-Editor) ────────────────────────────────

/// Sucht einen Baustein anhand seiner ID in der projektweiten Bibliothek
/// (`project.blocks`). IDs sind global eindeutig — die ID allein reicht.
fn find_block_mut<'a>(proj: &'a mut Project, block_id: &str) -> Option<&'a mut serde_json::Value> {
    proj.blocks
        .as_array_mut()?
        .iter_mut()
        .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id))
}

/// Grenzen für `block.setLength`. Die Auflösung bleibt bewusst grob geklemmt:
/// die Engine rechnet `pulsesPerBar / stepsPerBar` und rundet — jenseits von 64
/// Substeps pro Takt wird daraus bei 4/4 (96 Pulses) ohnehin nur noch Jitter.
const MIN_STEPS_PER_BAR: u32 = 1;
const MAX_STEPS_PER_BAR: u32 = 64;
const MAX_LENGTH_BARS: u32 = 16;

fn block_u32(b: &serde_json::Value, key: &str, default: u32) -> u32 {
    b.get(key).and_then(|v| v.as_u64()).unwrap_or(default as u64) as u32
}

/// Passt den Inhalt eines Bausteins an ein neues Raster an.
///
/// Zwei verschiedene Bewegungen, je nach Art des Inhalts:
///  • EREIGNISSE (Noten, Akkorde, Beat-Trigger, PC-/Pattern-Events) behalten
///    ihren Zeitpunkt: ihre Step-Nummer wird mit `new_spb / old_spb` skaliert.
///    Eine Verdopplung der Auflösung schiebt die Snare also von Step 4 auf 8 —
///    sie klingt an derselben Stelle, nur mit feinerem Raster dazwischen.
///  • VERLÄUFE (Stepped-CC-Werte) werden neu abgetastet (Sample & Hold), sonst
///    stünden zwischen den alten Werten Nullen und die Kurve wäre zerhackt.
///
/// Alles hinter `total` (= neue Gesamt-Stepzahl) fällt weg; Beat-Arrays und
/// Stepped-Werte werden exakt auf `total` gebracht, damit die Editoren die
/// neuen Steps auch anfassen können.
fn refit_block_content(b: &mut serde_json::Value, old_spb: u32, new_spb: u32, total: u32) {
    let scale = new_spb as f64 / old_spb as f64;
    let at = |step: u64| -> u64 { (step as f64 * scale).round() as u64 };
    let dur = |len: u64| -> u64 { ((len as f64 * scale).round() as u64).clamp(1, total as u64) };

    // Melodie / Akkorde: Position + Länge mitziehen, hinten Abgeschnittenes weg.
    for key in ["notes", "chords"] {
        if let Some(arr) = b.get_mut(key).and_then(|v| v.as_array_mut()) {
            for ev in arr.iter_mut() {
                if let Some(step) = ev.get("step").and_then(|v| v.as_u64()) {
                    ev["step"] = serde_json::json!(at(step));
                }
                if let Some(len) = ev.get("lengthSteps").and_then(|v| v.as_u64()) {
                    ev["lengthSteps"] = serde_json::json!(dur(len));
                }
            }
            arr.retain(|ev| ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0) < total as u64);
        }
    }

    // Program-Change / Pattern-Shift: nur eine Position, kein Länge-Feld.
    for key in ["events", "messages"] {
        if let Some(arr) = b.get_mut(key).and_then(|v| v.as_array_mut()) {
            for ev in arr.iter_mut() {
                if let Some(step) = ev.get("atStep").and_then(|v| v.as_u64()) {
                    ev["atStep"] = serde_json::json!(at(step));
                }
            }
            arr.retain(|ev| ev.get("atStep").and_then(|v| v.as_u64()).unwrap_or(0) < total as u64);
        }
    }

    // Beat: pro Line ein frisches Array der neuen Länge. Nur GESETZTE Steps
    // wandern mit (velocity > 0) — beim Verkleinern der Auflösung fallen sonst
    // Treffer auf leere Nachbarn und löschen sich gegenseitig aus.
    if let Some(lines) = b.get_mut("lines").and_then(|v| v.as_array_mut()) {
        for line in lines.iter_mut() {
            let old_steps = line
                .get("steps")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut new_steps: Vec<serde_json::Value> =
                (0..total).map(|_| serde_json::json!({ "velocity": 0 })).collect();
            for (i, s) in old_steps.iter().enumerate() {
                let t = at(i as u64) as usize;
                if t < new_steps.len() && s.get("velocity").and_then(|v| v.as_u64()).unwrap_or(0) > 0 {
                    new_steps[t] = s.clone();
                }
            }
            line["steps"] = serde_json::Value::Array(new_steps);
        }
    }

    // CC-Layer: Stepped neu abtasten, Envelope-Punkte wie Ereignisse verschieben,
    // Random-Intervall im selben Verhältnis mitziehen.
    if let Some(layers) = b.get_mut("layers").and_then(|v| v.as_array_mut()) {
        for layer in layers.iter_mut() {
            match layer.get("kind").and_then(|v| v.as_str()) {
                Some("stepped") => {
                    let old_values: Vec<f64> = layer
                        .get("values")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
                        .unwrap_or_default();
                    let values: Vec<serde_json::Value> = (0..total as usize)
                        .map(|i| {
                            let src = (i as f64 / scale).floor() as usize;
                            serde_json::json!(old_values.get(src).copied().unwrap_or(0.0))
                        })
                        .collect();
                    layer["values"] = serde_json::Value::Array(values);
                }
                Some("envelope") => {
                    if let Some(points) = layer.get_mut("points").and_then(|v| v.as_array_mut()) {
                        for p in points.iter_mut() {
                            if let Some(step) = p.get("step").and_then(|v| v.as_u64()) {
                                p["step"] = serde_json::json!(at(step));
                            }
                        }
                        points.retain(|p| p.get("step").and_then(|v| v.as_u64()).unwrap_or(0) < total as u64);
                    }
                }
                Some("random") => {
                    if let Some(every) = layer.get("everySteps").and_then(|v| v.as_u64()) {
                        layer["everySteps"] = serde_json::json!(dur(every));
                    }
                }
                _ => {}
            }
        }
    }

    // Arp: Gate/Rate sind Step-Längen, also ebenfalls auflösungsabhängig.
    for key in ["gateSteps", "rateSteps"] {
        if let Some(v) = b.get(key).and_then(|v| v.as_u64()) {
            b[key] = serde_json::json!(dur(v));
        }
    }
}

fn find_beat_line_mut<'a>(block: &'a mut serde_json::Value, line_id: &str) -> Option<&'a mut serde_json::Value> {
    block
        .get_mut("lines")?
        .as_array_mut()?
        .iter_mut()
        .find(|l| l.get("id").and_then(|v| v.as_str()) == Some(line_id))
}

fn find_cc_layer_mut<'a>(block: &'a mut serde_json::Value, layer_id: &str) -> Option<&'a mut serde_json::Value> {
    block
        .get_mut("layers")?
        .as_array_mut()?
        .iter_mut()
        .find(|l| l.get("id").and_then(|v| v.as_str()) == Some(layer_id))
}

/// Neuer Layer mit sinnvollen Defaults für seine Art (siehe `CcLayer` im
/// Modell — alle Werte 0..1 normiert, unabhängig von `outMin`/`outMax`).
fn default_cc_layer(kind: &str, steps: usize) -> Option<serde_json::Value> {
    let base = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "kind": kind,
        "enabled": true,
        "combine": "add",
        "depth": 1.0,
        "offset": 0.0,
    });
    let mut layer = base;
    match kind {
        "lfo" => {
            layer["waveform"] = serde_json::json!("sine");
            layer["rateMode"] = serde_json::json!("bars");
            layer["rateBars"] = serde_json::json!(1.0);
            layer["rateHz"] = serde_json::json!(1.0);
            layer["phase"] = serde_json::json!(0.0);
        }
        "envelope" => {
            layer["points"] = serde_json::json!([]);
        }
        "ramp" => {
            layer["from"] = serde_json::json!(0.0);
            layer["to"] = serde_json::json!(1.0);
        }
        "random" => {
            layer["everySteps"] = serde_json::json!(1);
            layer["smooth"] = serde_json::json!(false);
        }
        "stepped" => {
            layer["values"] = serde_json::json!(vec![0.0f64; steps]);
        }
        _ => return None,
    }
    Some(layer)
}

/// Erste freie (row, col)-Position im 9×9-Raster dieses Bausteintyps
/// (row-major: 1-1, 1-2, …, 9-9). `None`, wenn alle 81 Zellen belegt sind.
/// `blocks` ist die projektweite Bibliothek (`project.blocks`).
fn next_free_slot(blocks: &serde_json::Value, block_type: &str) -> Option<(u8, u8)> {
    let taken: std::collections::HashSet<(u8, u8)> = blocks
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some(block_type))
                .filter_map(|b| {
                    let slot = b.get("slot")?;
                    let row = slot.get("row")?.as_u64()? as u8;
                    let col = slot.get("col")?.as_u64()? as u8;
                    Some((row, col))
                })
                .collect()
        })
        .unwrap_or_default();
    for row in 1u8..=9 {
        for col in 1u8..=9 {
            if !taken.contains(&(row, col)) {
                return Some((row, col));
            }
        }
    }
    None
}

// ── Lane-Control-Helfer (Schnellbedienung) ─────────────────────────────────

fn find_lane<'a>(proj: &'a Project, lane_id: &str) -> Option<(&'a Device, &'a Lane)> {
    for d in &proj.devices {
        if let Some(l) = d.lanes.iter().find(|l| l.id == lane_id) {
            return Some((d, l));
        }
    }
    None
}

fn find_lane_mut<'a>(proj: &'a mut Project, lane_id: &str) -> Option<&'a mut Lane> {
    for d in proj.devices.iter_mut() {
        if let Some(l) = d.lanes.iter_mut().find(|l| l.id == lane_id) {
            return Some(l);
        }
    }
    None
}

/// Ob `control_id` ein zulässiges CC-Ziel für diese Lane ist: ein gelernter
/// Knob mit CC-Mapping, der zum SELBEN Device gehört wie die Lane. Gemeinsame
/// Regel für `lane.setCcControl` und den Macro-Knob eines Lane-Controls —
/// „in Lanes nur CCs wählen, die auch verbunden sind".
fn lane_can_target_control(proj: &Project, lane_id: &str, control_id: &str) -> bool {
    let Some((dev, _)) = find_lane(proj, lane_id) else { return false };
    let Some(ctrl) = find_control(proj, control_id) else { return false };
    ctrl.get("kind").and_then(|v| v.as_str()) == Some("knob")
        && ctrl.get("deviceId").and_then(|v| v.as_str()) == Some(dev.id.as_str())
        && ctrl
            .get("mapping")
            .and_then(|m| m.get("kind"))
            .and_then(|v| v.as_str())
            == Some("cc")
}

fn find_lane_control<'a>(lane: &'a Lane, control_id: &str) -> Option<&'a serde_json::Value> {
    lane.controls
        .as_array()?
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(control_id))
}

fn find_lane_control_mut<'a>(lane: &'a mut Lane, control_id: &str) -> Option<&'a mut serde_json::Value> {
    lane.controls
        .as_array_mut()?
        .iter_mut()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(control_id))
}

/// (Port, Kanal) für eine Lane — der Kanal sitzt an der Lane, der Port am Device.
fn lane_port_channel(dev: &Device, lane: &Lane) -> (String, u8) {
    let ch = lane.channel.clamp(1, 16);
    (dev.midi_out_port.clone(), ch)
}

/// Wohin ein Probeton aus dem Baustein-Detail geht (Port, Kanal 1–16).
///
/// Ein Baustein trägt selbst KEIN Ziel — kein Port, kein Kanal (s. `BlockBase`
/// in shared/model.ts): das Ziel sitzt an der Lane. Zum Anspielen wird deshalb
/// die erste Lane gesucht, die diesen Baustein wirklich in einem Slot hat —
/// das ist das Gerät, auf dem er beim Abspielen auch klingt. Steckt er noch in
/// keiner Lane (frisch aus der Bibliothek), tut es die erste Lane mit passender
/// Rolle, sonst die erste Lane überhaupt: zum Vorhören ist irgendein hörbares
/// Ziel besser als Stille.
fn block_preview_target(proj: &Project, block_id: &str) -> Option<(String, u8)> {
    let role = proj
        .blocks
        .as_array()
        .and_then(|a| a.iter().find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id)))
        .and_then(|b| b.get("type").and_then(|v| v.as_str()))
        .map(str::to_string);

    let mut by_role: Option<(String, u8)> = None;
    let mut any: Option<(String, u8)> = None;
    for dev in &proj.devices {
        for lane in &dev.lanes {
            let uses_block = lane.slots.as_array().is_some_and(|slots| {
                slots
                    .iter()
                    .any(|s| s.get("blockId").and_then(|v| v.as_str()) == Some(block_id))
            });
            if uses_block {
                return Some(lane_port_channel(dev, lane));
            }
            if by_role.is_none() && role.as_deref() == Some(lane.role.as_str()) {
                by_role = Some(lane_port_channel(dev, lane));
            }
            if any.is_none() {
                any = Some(lane_port_channel(dev, lane));
            }
        }
    }
    by_role.or(any)
}

/// Armiert (bzw. entwaffnet mit `None`) die Noten-Eingabe der Piano-Rolle.
///
/// Beim Entwaffnen bekommt jede Note, die das Mithören noch hält, ihr
/// Note-Off — ein Editor, den man mitten im Akkord schließt, dürfte sonst
/// einen Ton stehen lassen, den nur noch Panic beendet.
fn set_note_input(state: &AppState, block_id: Option<&str>) {
    let echo = block_id.and_then(|id| {
        let proj = state.project.lock().unwrap();
        block_preview_target(&proj, id)
    });

    let previous = {
        let mut guard = state.note_input.lock().unwrap();
        let previous = guard.take();
        *guard = block_id.map(|id| crate::state::NoteInputArm {
            block_id: id.to_string(),
            echo,
            held: std::collections::HashSet::new(),
        });
        previous
    };

    if let Some(prev) = previous {
        if let Some((port, ch)) = prev.echo {
            for note in prev.held {
                state
                    .clock
                    .send(ClockCommand::Midi(port.clone(), vec![0x80 | (ch - 1), note, 0]));
            }
        }
    }

    let _ = state.events.send(serde_json::json!({
        "t": "noteInput.armed",
        "blockId": block_id,
    }));
}

/// Feuert ein Lane-Control live (Press/Release) — Drum-Trigger, Mute-Toggle,
/// Noten-Control oder MIDI-Signal-Button. Läuft am Playback-Engine vorbei,
/// direkt wie die Live-Controls im Dashboard.
fn lane_control_trigger(state: &AppState, lane_id: &str, control_id: &str, pressed: bool) {
    let (port, ch, kind, action, note, vel, target_block, target_line, message) = {
        let proj = state.project.lock().unwrap();
        let Some((dev, lane)) = find_lane(&proj, lane_id) else { return };
        let Some(ctrl) = find_lane_control(lane, control_id) else { return };
        let (port, ch) = lane_port_channel(dev, lane);
        let kind = ctrl.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let action = ctrl.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let note = ctrl.get("note").and_then(|v| v.as_u64()).unwrap_or(60) as u8;
        let vel = ctrl.get("velocity").and_then(|v| v.as_u64()).unwrap_or(100) as u8;
        let target_block = ctrl.get("targetBlockId").and_then(|v| v.as_str()).map(str::to_string);
        let target_line = ctrl.get("targetLineId").and_then(|v| v.as_str()).map(str::to_string);
        let message = ctrl.get("message").cloned();
        (port, ch, kind, action, note, vel, target_block, target_line, message)
    };

    match kind.as_str() {
        "drumButton" if action == "trigger" => {
            let bytes = if pressed {
                vec![0x90 | (ch - 1), note, vel]
            } else {
                vec![0x80 | (ch - 1), note, 0]
            };
            state.clock.send(ClockCommand::Midi(port, bytes));
        }
        "drumButton" if action == "muteToggle" => {
            if pressed {
                if let (Some(bid), Some(lid)) = (target_block, target_line) {
                    let mut proj = state.project.lock().unwrap();
                    if let Some(b) = find_block_mut(&mut proj, &bid) {
                        if let Some(line) = find_beat_line_mut(b, &lid) {
                            let cur = line.get("muted").and_then(|v| v.as_bool()).unwrap_or(false);
                            line["muted"] = serde_json::json!(!cur);
                        }
                    }
                    drop(proj);
                    broadcast_snapshot(state);
                }
            }
        }
        "note" => {
            let bytes = if pressed {
                vec![0x90 | (ch - 1), note, vel]
            } else {
                vec![0x80 | (ch - 1), note, 0]
            };
            state.clock.send(ClockCommand::Midi(port, bytes));
        }
        "midiSignal" => {
            if let Some(msg) = message {
                if let Some(bytes) = message_bytes(ch, &msg, pressed) {
                    state.clock.send(ClockCommand::Midi(port, bytes));
                }
            }
        }
        _ => {}
    }
}

/// Setzt den Wert eines Macro-Knobs einer Lane. Der Macro-Knob ist nur eine
/// Fernbedienung für einen gelernten Dashboard-Knob (`controlId`): Wert, Kanal
/// und CC-Nummer liegen dort, damit Lane und Dashboard denselben Regler zeigen
/// statt zwei Wahrheiten zu führen — und damit hier gar kein freies CC gewählt
/// werden kann, das an keinem Gerät hängt.
///
/// Bewusst OHNE `broadcast_snapshot`: beim Ziehen kommen sehr viele Werte
/// hintereinander: ein voller Snapshot (inkl. Autosave) pro Wert wäre unnötige
/// Last — dieselbe Überlegung wie bei `control.setValue`.
fn lane_control_set_value(state: &AppState, lane_id: &str, control_id: &str, value: u8) {
    let target_id = {
        let proj = state.project.lock().unwrap();
        let Some((_, lane)) = find_lane(&proj, lane_id) else { return };
        let Some(ctrl) = find_lane_control(lane, control_id) else { return };
        ctrl.get("controlId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let Some(target_id) = target_id else { return };

    let mut proj = state.project.lock().unwrap();
    if let Some(c) = find_control_mut(&mut proj, &target_id) {
        c["value"] = serde_json::json!(value);
    }
    let cc = control_cc(&proj, &target_id);
    drop(proj);

    match cc {
        Some((port, ch, num)) => {
            state
                .clock
                .send(ClockCommand::Midi(port, vec![0xB0 | (ch - 1), num, value]));
            let _ = state.events.send(serde_json::json!({
                "t": "control.valueChanged",
                "controlId": target_id,
                "value": value,
            }));
        }
        None => warn_no_mapping(state, &target_id),
    }
}

/// Baut MIDI-Bytes aus einer `PatternMessage` für Press/Release eines
/// MidiSignalControl. Release ist nur bei `kind=="note"` sinnvoll (Note-Off) —
/// PC/CC/PitchBend feuern als einmaliger Impuls beim Press.
fn message_bytes(channel: u8, msg: &serde_json::Value, pressed: bool) -> Option<Vec<u8>> {
    let kind = msg.get("kind").and_then(|v| v.as_str())?;
    let ch = channel.clamp(1, 16) - 1;
    let data1 = msg.get("data1").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
    let data2 = msg.get("data2").and_then(|v| v.as_u64()).unwrap_or(127) as u8;
    match kind {
        "note" => Some(if pressed {
            vec![0x90 | ch, data1, data2]
        } else {
            vec![0x80 | ch, data1, 0]
        }),
        "cc" if pressed => Some(vec![0xB0 | ch, data1, data2]),
        "programChange" if pressed => Some(vec![0xC0 | ch, data1]),
        "pitchBend" if pressed => {
            let v14 = msg.get("value14").and_then(|v| v.as_u64()).unwrap_or(8192) as u16;
            Some(vec![0xE0 | ch, (v14 & 0x7F) as u8, ((v14 >> 7) & 0x7F) as u8])
        }
        _ => None,
    }
}

// ── Control-Helfer (Live-Controls) ─────────────────────────────────────────

fn find_control_mut<'a>(proj: &'a mut Project, id: &str) -> Option<&'a mut serde_json::Value> {
    proj.controls
        .as_array_mut()?
        .iter_mut()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn find_control(proj: &Project, id: &str) -> Option<serde_json::Value> {
    proj.controls
        .as_array()?
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
        .cloned()
}

/// Ob dem Control ein Ziel-Device zugewiesen ist (sonst geht MIDI nur an den virtuellen Port).
fn has_device(proj: &Project, id: &str) -> bool {
    find_control(proj, id)
        .and_then(|c| c.get("deviceId").cloned())
        .map(|v| v.is_string())
        .unwrap_or(false)
}

/// Warnt die UI, dass ein Control kein Ziel-Device hat — gedrosselt, damit ein
/// gezogener CC-Regler (viele setValue-Events/Sekunde) die UI nicht flutet.
fn warn_no_device(state: &AppState, control_id: &str) {
    const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(3);
    let mut last = state.last_device_warning.lock().unwrap();
    let now = std::time::Instant::now();
    if last.map(|t| now.duration_since(t) < COOLDOWN).unwrap_or(false) {
        return;
    }
    *last = Some(now);
    let _ = state.events.send(serde_json::json!({
        "t": "control.sendError",
        "controlId": control_id,
        "message": "No device assigned — pick one via \"Device …\" in the context menu, otherwise sound only goes to the virtual port.",
    }));
}

/// Warnt die UI, dass ein Control noch keine CC-Zuordnung hat — z.B. ein
/// frisch angelegter Makro-Knopf, der noch nie per MIDI-Learn belegt wurde.
/// Ohne diese Meldung verschwindet `control.setValue` sonst lautlos: der
/// `value` im Projekt-State ändert sich (UI zeigt Bewegung), aber es geht
/// kein einziges Byte raus, ohne dass irgendwas das meldet. Gleiches
/// Cooldown-Timing wie `warn_no_device` (viele setValue-Events beim Ziehen).
fn warn_no_mapping(state: &AppState, control_id: &str) {
    const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(3);
    let mut last = state.last_device_warning.lock().unwrap();
    let now = std::time::Instant::now();
    if last.map(|t| now.duration_since(t) < COOLDOWN).unwrap_or(false) {
        return;
    }
    *last = Some(now);
    let _ = state.events.send(serde_json::json!({
        "t": "control.sendError",
        "controlId": control_id,
        "message": "This control has no CC mapping yet — long-press it and MIDI-learn a knob/fader to send it out.",
    }));
}

/// Ziel-Port eines Controls: Device-Port oder leer (→ virtueller Port).
fn control_port(proj: &Project, ctrl: &serde_json::Value) -> String {
    control_device(proj, ctrl).map(|d| d.midi_out_port.clone()).unwrap_or_default()
}

fn control_device<'a>(proj: &'a Project, ctrl: &serde_json::Value) -> Option<&'a Device> {
    let did = ctrl.get("deviceId").and_then(|v| v.as_str())?;
    proj.devices.iter().find(|d| d.id == did)
}

/// MIDI-Bytes für Press/Release eines Taster-Controls — abhängig vom
/// gelernten Mapping-Typ:
///  - `note`: Note-On (press) / Note-Off (release).
///  - `cc`: nur wenn der Nutzer das CC explizit als Taster gewählt hat
///    (`ctrl.kind == "button"`, siehe `control.setKind`) — sonst ist es ein
///    Drehregler und läuft über `control.setValue`/`control_cc`. Sendet
///    127 (press) / 0 (release), wie ein typischer Controller-Taster.
///  - `programChange`: nur press (PC kennt kein Release).
///
/// Kanal kommt bewusst IMMER aus dem beim Lernen aufgezeichneten Mapping,
/// nicht vom zugewiesenen Device: ein Keyboard wie das P-6 kann Noten auf
/// unterschiedlichen Kanälen senden (Zonen/Parts), und genau der beim Lernen
/// erfasste Kanal ist der, den das Zielgerät für *diese* Note tatsächlich
/// erwartet. Ein Device-Kanal als Override hat früher genau das kaputt
/// gemacht (Kanal 4 wurde durch den alten Geräte-Kanal 11 überschrieben).
fn control_trigger(proj: &Project, id: &str, pressed: bool) -> Option<(String, Vec<u8>)> {
    let ctrl = find_control(proj, id)?;
    // "keyboard"-Controls sind eine reine Live-Aktivitäts-Anzeige (matchen
    // jede Note ihres Kanals) — kein einzelner Ton zum Antippen.
    if ctrl.get("kind").and_then(|v| v.as_str()) == Some("keyboard") {
        return None;
    }
    let map = ctrl.get("mapping")?;
    let kind = map.get("kind").and_then(|v| v.as_str())?;
    let ch = (map.get("channel").and_then(|v| v.as_u64()).unwrap_or(1) as u8).clamp(1, 16);
    let num = map.get("number").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
    let port = control_port(proj, &ctrl);
    match kind {
        "note" => {
            let bytes = if pressed {
                vec![0x90 | (ch - 1), num, 100]
            } else {
                vec![0x80 | (ch - 1), num, 0]
            };
            Some((port, bytes))
        }
        "cc" if ctrl.get("kind").and_then(|v| v.as_str()) == Some("button") => {
            let val = if pressed { 127 } else { 0 };
            Some((port, vec![0xB0 | (ch - 1), num, val]))
        }
        "programChange" if pressed => Some((port, vec![0xC0 | (ch - 1), num])),
        _ => None,
    }
}

/// (Port, Kanal 1–16, CC-Nummer) falls das Control CC sendet.
fn control_cc(proj: &Project, id: &str) -> Option<(String, u8, u8)> {
    let ctrl = find_control(proj, id)?;
    let map = ctrl.get("mapping")?;
    if map.get("kind").and_then(|v| v.as_str())? != "cc" {
        return None;
    }
    let ch = (map.get("channel").and_then(|v| v.as_u64()).unwrap_or(1) as u8).clamp(1, 16);
    let num = map.get("number").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
    Some((control_port(proj, &ctrl), ch, num))
}

// ── Default-Inhalte für neu angelegte Bausteine ─────────────────────────────
// `slot` wird bewusst NICHT hier gesetzt — der Aufrufer weist per
// `next_free_slot` die nächste freie (row, col) im 9×9-Raster des Typs zu.

fn demo_slot(block_id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "blockId": block_id,
        "transpose": 0,
        "speed": 1,
        // "off" (einmal), NICHT "loop": sonst rückt "sequential"/"random" nie
        // weiter, weil der Slot nie fertig wird (bei nur einem Slot in der
        // Lane unsichtbar, da er ohnehin zu sich selbst zurück-wrapped).
        "loopMode": "off",
        "loopCount": 0,
    })
}

fn default_block_for(role: &str) -> Option<serde_json::Value> {
    match role {
        "melody" => Some(blank_melody_block()),
        "beat" => Some(blank_beat_block()),
        "cc" => Some(default_cc_block()),
        "chord" => Some(default_chord_block()),
        "arp" => Some(default_arp_block()),
        "programChange" => Some(default_program_change_block()),
        "patternShift" => Some(default_pattern_shift_block()),
        _ => None,
    }
}

/// Leerer Baustein — jeder neu angelegte Melodie-Baustein startet ohne Noten
/// (nicht mehr mit einer festen Demo-Bassline geklont), damit "+" jedes Mal
/// wirklich etwas Neues anlegt statt derselben Kachel mit anderer ID.
fn blank_melody_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "melody",
        "name": "Mel",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "baseNote": 60,
        "notes": [],
    })
}

/// Leerer Baustein mit drei benannten, aber stummen Lines (Kick/Snare/Hat) —
/// das Beat-Editor-Grid kann bislang keine Lines hinzufügen/entfernen, daher
/// müssen die Lines vorhanden sein; das Muster selbst ist aber leer, nicht
/// die feste Demo-Groove-Kopie.
fn blank_beat_block() -> serde_json::Value {
    let line = |name: &str, note: u8| {
        let steps: Vec<serde_json::Value> = (0..16).map(|_| serde_json::json!({ "velocity": 0 })).collect();
        serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": name,
            "note": note,
            "muted": false,
            "steps": steps,
        })
    };
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "beat",
        "name": "Beat",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "lines": [line("Kick", 36), line("Snare", 38), line("Hat", 42)],
    })
}

/// Ein CC-Baustein beschreibt NUR die Bewegung (Layer + Wertebereich). Wohin
/// sie geht — Gerät, Kanal, CC-Nummer — entscheidet die Lane über ihren
/// Ziel-Knob (`Lane.ccControlId`), damit derselbe Baustein in mehreren Lanes
/// auf unterschiedlichen CCs laufen kann.
fn default_cc_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "cc",
        "name": "CC",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "outMin": 0,
        "outMax": 127,
        "layers": [{
            "id": uuid::Uuid::new_v4().to_string(),
            "kind": "stepped",
            "enabled": true,
            "combine": "replace",
            "depth": 1.0,
            "offset": 0.0,
            "values": vec![0.0f64; 16],
        }],
    })
}

fn default_chord_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "chord",
        "name": "Chord",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "baseNote": 60,
        "chords": [],
    })
}

fn default_arp_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "arp",
        "name": "Arp",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "baseNote": 60,
        "chordNotes": [],
        "direction": "up",
        "gateSteps": 1,
        "rateSteps": 1,
        "velocity": 100,
    })
}

fn default_program_change_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "programChange",
        "name": "PC",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "events": [],
    })
}

fn default_pattern_shift_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "patternShift",
        "name": "Ptn",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "messages": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Auflösung verdoppeln: die Musik bleibt an derselben Stelle, nur das
    /// Raster darum wird feiner.
    #[test]
    fn doubling_the_resolution_keeps_events_in_time() {
        let mut block = serde_json::json!({
            "type": "melody",
            "notes": [{ "step": 0, "lengthSteps": 2, "note": 60, "velocity": 100 },
                      { "step": 4, "lengthSteps": 1, "note": 63, "velocity": 100 }],
        });
        refit_block_content(&mut block, 16, 32, 32);
        let notes = block["notes"].as_array().unwrap();
        assert_eq!(notes[0]["step"], 0);
        assert_eq!(notes[0]["lengthSteps"], 4);
        assert_eq!(notes[1]["step"], 8);
        assert_eq!(notes[1]["lengthSteps"], 2);
    }

    /// Beat-Lines bekommen exakt die neue Gesamtlänge — sonst könnten die
    /// hinzugekommenen Steps im Editor nicht angetippt werden (`beat.toggleStep`
    /// greift nur auf vorhandene Indizes zu).
    #[test]
    fn beat_lines_are_resized_and_hits_move_with_the_grid() {
        let steps: Vec<serde_json::Value> = (0..16)
            .map(|i| serde_json::json!({ "velocity": if i == 4 { 100 } else { 0 } }))
            .collect();
        let mut block = serde_json::json!({ "type": "beat", "lines": [{ "steps": steps }] });
        refit_block_content(&mut block, 16, 32, 64); // 32 Substeps, 2 Takte
        let out = block["lines"][0]["steps"].as_array().unwrap();
        assert_eq!(out.len(), 64);
        assert_eq!(out[8]["velocity"], 100);
        assert_eq!(out[4]["velocity"], 0);
    }

    /// Kürzen (2 Takte → 1) schneidet hinten ab, statt Events auf den letzten
    /// Step zu stapeln. Die Auflösung bleibt dabei gleich, die Positionen auch.
    #[test]
    fn shrinking_drops_events_past_the_new_end() {
        let mut block = serde_json::json!({
            "type": "programChange",
            "events": [{ "atStep": 4, "program": 1 }, { "atStep": 20, "program": 2 }],
        });
        refit_block_content(&mut block, 16, 16, 16);
        let events = block["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["atStep"], 4);
    }

    /// Stepped-CC ist ein Verlauf, kein Ereignis: neu abtasten (Sample & Hold),
    /// damit zwischen den alten Werten keine Nullen stehen.
    #[test]
    fn stepped_cc_values_are_resampled() {
        let mut block = serde_json::json!({
            "type": "cc",
            "layers": [{ "kind": "stepped", "values": [0.25, 0.5] }],
        });
        refit_block_content(&mut block, 2, 4, 4);
        assert_eq!(
            block["layers"][0]["values"],
            serde_json::json!([0.25, 0.25, 0.5, 0.5])
        );
    }
}
