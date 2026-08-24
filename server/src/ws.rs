//! WebSocket-Endpunkt: empfängt Commands (UI → Server) und pusht Events
//! (Server → UI). Command-Dispatch fürs Grundgerüst: Transport + Projekt.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};

use crate::clock::ClockCommand;
use crate::midi;
use crate::model::{ClockSource, Device, Lane, Project};
use crate::state::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();

    // Beim Verbinden: verfügbare MIDI-Ports + voller Zustand.
    let (outputs, inputs) = midi::list_ports();
    let ports = serde_json::json!({ "t": "midi.ports", "outputs": outputs, "inputs": inputs });
    let _ = sender.send(Message::Text(ports.to_string())).await;
    let _ = sender
        .send(Message::Text(state.snapshot_event().to_string()))
        .await;

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
        "project.save" => {
            if let Err(e) = state.save_project() {
                tracing::warn!("Projekt speichern fehlgeschlagen: {e}");
            }
        }
        "project.create" => {
            let name = cmd
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Neues Projekt");
            let proj = Project::new(name);
            *state.project.lock().unwrap() = proj;
            broadcast_snapshot(state);
        }
        "project.load" => {
            if let Some(id) = cmd.get("projectId").and_then(|v| v.as_str()) {
                match state.load_project(id) {
                    Ok(p) => {
                        *state.project.lock().unwrap() = p;
                        broadcast_snapshot(state);
                    }
                    Err(e) => tracing::warn!("Projekt laden fehlgeschlagen: {e}"),
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
        "device.setChannel" => {
            if let (Some(id), Some(ch)) = (
                str_field(&cmd, "deviceId"),
                cmd.get("channel").and_then(|v| v.as_u64()),
            ) {
                with_device(state, &id, |d| d.channel = ch as u8);
            }
        }
        "device.setTranspose" => {
            if let (Some(id), Some(t)) = (
                str_field(&cmd, "deviceId"),
                cmd.get("transpose").and_then(|v| v.as_i64()),
            ) {
                with_device(state, &id, |d| d.transpose = (t as i32).clamp(-36, 36));
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
        // ── Lanes ──
        "lane.create" => {
            if let Some(device_id) = str_field(&cmd, "deviceId") {
                let role = str_field(&cmd, "role").unwrap_or_else(|| "melody".to_string());
                let name = str_field(&cmd, "name");
                with_device(state, &device_id, |d| {
                    let n = name
                        .clone()
                        .unwrap_or_else(|| format!("Lane {}", d.lanes.len() + 1));
                    let mut lane = Lane::new(&role, n);
                    // Starter-Inhalt, damit sofort etwas da ist (Melodie/Beat klingen
                    // sofort; die übrigen Typen sind zumindest editierbar).
                    if let Some(mut block) = default_block_for(&role) {
                        if let Some((row, col)) = next_free_slot(d, &role) {
                            block["slot"] = serde_json::json!({ "type": role, "row": row, "col": col });
                            let block_id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            if let Some(arr) = d.blocks.as_array_mut() {
                                arr.push(block);
                            }
                            lane.slots = serde_json::json!([demo_slot(&block_id)]);
                        }
                    }
                    d.lanes.push(lane);
                });
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
                if let Some((port, ch, num)) = control_cc(&proj, &id) {
                    if !has_device(&proj, &id) {
                        warn_no_device(state, &id);
                    }
                    state
                        .clock
                        .send(ClockCommand::Midi(port, vec![0xB0 | (ch - 1), num, value]));
                }
            }
        }
        // ── Lane-Controls (Schnellbedienung: Drum-Buttons, Macro-Knobs, …) ──
        "laneControl.add" => {
            if let (Some(lane_id), Some(mut control)) =
                (str_field(&cmd, "laneId"), cmd.get("control").cloned())
            {
                let mut proj = state.project.lock().unwrap();
                if let Some(lane) = find_lane_mut(&mut proj, &lane_id) {
                    if !lane.controls.is_array() {
                        lane.controls = serde_json::json!([]);
                    }
                    let order = lane.controls.as_array().map(|a| a.len()).unwrap_or(0);
                    control["id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
                    control["order"] = serde_json::json!(order);
                    lane.controls.as_array_mut().unwrap().push(control);
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
                state.clock.send(ClockCommand::TriggerSlot(lane_id, slot_id));
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
            if let (Some(device_id), Some(block_type), Some(row), Some(col)) = (
                str_field(&cmd, "deviceId"),
                str_field(&cmd, "blockType"),
                cmd.get("row").and_then(|v| v.as_u64()),
                cmd.get("col").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(d) = proj.devices.iter_mut().find(|d| d.id == device_id) {
                    let occupied = d.blocks.as_array().map(|arr| {
                        arr.iter().any(|b| {
                            b.get("type").and_then(|v| v.as_str()) == Some(block_type.as_str())
                                && b.get("slot").and_then(|s| s.get("row")).and_then(|v| v.as_u64()) == Some(row)
                                && b.get("slot").and_then(|s| s.get("col")).and_then(|v| v.as_u64()) == Some(col)
                        })
                    }).unwrap_or(false);
                    if !occupied {
                        if let Some(mut block) = default_block_for(&block_type) {
                            block["slot"] = serde_json::json!({ "type": block_type, "row": row, "col": col });
                            if let Some(arr) = d.blocks.as_array_mut() {
                                arr.push(block);
                            }
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
        }
        // Baustein-Bibliothek: entfernt einen Baustein endgültig und räumt
        // dangling Lane-Slot-Referenzen im selben Device auf.
        "block.delete" => {
            if let Some(id) = str_field(&cmd, "blockId") {
                let mut proj = state.project.lock().unwrap();
                if let Some(d) = proj.devices.iter_mut().find(|d| {
                    d.blocks
                        .as_array()
                        .map(|arr| arr.iter().any(|b| b.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
                        .unwrap_or(false)
                }) {
                    if let Some(arr) = d.blocks.as_array_mut() {
                        arr.retain(|b| b.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
                    }
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
        // Generischer Skalarfeld-Setter für Baustein-Felder, die keine
        // strukturelle Array-Logik brauchen (Kanal-Override, ccNumber,
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
        // Baustein-Detail: Note bei (step, note) an/aus — Grundlage für den
        // Melodie-Editor (Piano-Roll-Grid).
        "melody.toggleNote" => {
            if let (Some(id), Some(step), Some(note)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("note").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if !b["notes"].is_array() {
                        b["notes"] = serde_json::json!([]);
                    }
                    if let Some(arr) = b["notes"].as_array_mut() {
                        let existing = arr.iter().position(|n| {
                            n.get("step").and_then(|v| v.as_u64()) == Some(step)
                                && n.get("note").and_then(|v| v.as_u64()) == Some(note)
                        });
                        if let Some(i) = existing {
                            arr.remove(i);
                        } else {
                            arr.push(serde_json::json!({
                                "step": step,
                                "lengthSteps": 1,
                                "note": note,
                                "velocity": 100,
                            }));
                        }
                    }
                }
                drop(proj);
                broadcast_snapshot(state);
            }
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
        // CC-Detail: Wert eines Steps der (einzigen, impliziten) Stepped-Layer setzen.
        "cc.setStepValue" => {
            if let (Some(id), Some(step), Some(value)) = (
                str_field(&cmd, "blockId"),
                cmd.get("step").and_then(|v| v.as_u64()),
                cmd.get("value").and_then(|v| v.as_u64()),
            ) {
                let mut proj = state.project.lock().unwrap();
                if let Some(b) = find_block_mut(&mut proj, &id) {
                    if let Some(layer) = first_stepped_layer_mut(b) {
                        if let Some(values) = layer["values"].as_array_mut() {
                            if let Some(slot) = values.get_mut(step as usize) {
                                *slot = serde_json::json!(value.min(127));
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
                    for d in proj.devices.iter_mut() {
                        if let Some(pos) = d.lanes.iter().position(|l| l.id == lane_id) {
                            let role = d.lanes[pos].role.clone();
                            if let Some(mut block) = default_block_for(&role) {
                                if let Some((row, col)) = next_free_slot(d, &role) {
                                    block["slot"] = serde_json::json!({ "type": role, "row": row, "col": col });
                                    let bid = block
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default()
                                        .to_string();
                                    if let Some(arr) = d.blocks.as_array_mut() {
                                        arr.push(block);
                                    }
                                    if let Some(sl) = d.lanes[pos].slots.as_array_mut() {
                                        sl.push(demo_slot(&bid));
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
                broadcast_snapshot(state);
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

/// Sucht einen Baustein anhand seiner ID über alle Devices hinweg (Bausteine
/// leben in `device.blocks`, IDs sind global eindeutig — die ID allein reicht).
fn find_block_mut<'a>(proj: &'a mut Project, block_id: &str) -> Option<&'a mut serde_json::Value> {
    for d in proj.devices.iter_mut() {
        if let Some(arr) = d.blocks.as_array_mut() {
            if let Some(b) = arr
                .iter_mut()
                .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(block_id))
            {
                return Some(b);
            }
        }
    }
    None
}

fn find_beat_line_mut<'a>(block: &'a mut serde_json::Value, line_id: &str) -> Option<&'a mut serde_json::Value> {
    block
        .get_mut("lines")?
        .as_array_mut()?
        .iter_mut()
        .find(|l| l.get("id").and_then(|v| v.as_str()) == Some(line_id))
}

/// Die (einzige, implizite) Stepped-Layer eines CC-Bausteins.
fn first_stepped_layer_mut(block: &mut serde_json::Value) -> Option<&mut serde_json::Value> {
    block
        .get_mut("layers")?
        .as_array_mut()?
        .iter_mut()
        .find(|l| l.get("kind").and_then(|v| v.as_str()) == Some("stepped"))
}

/// Erste freie (row, col)-Position im 9×9-Raster dieses Bausteintyps
/// (row-major: 1-1, 1-2, …, 9-9). `None`, wenn alle 81 Zellen belegt sind.
fn next_free_slot(dev: &Device, block_type: &str) -> Option<(u8, u8)> {
    let taken: std::collections::HashSet<(u8, u8)> = dev
        .blocks
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

/// (Port, Kanal) für eine Lane — Lane-Channel-Override oder Device-Default.
fn lane_port_channel(dev: &Device, lane: &Lane) -> (String, u8) {
    let ch = lane.channel.unwrap_or(dev.channel).clamp(1, 16);
    (dev.midi_out_port.clone(), ch)
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

/// Persistiert den Wert eines Macro-Knob-Controls und sendet den CC live.
fn lane_control_set_value(state: &AppState, lane_id: &str, control_id: &str, value: u8) {
    let mut proj = state.project.lock().unwrap();
    let Some((port, ch)) = find_lane(&proj, lane_id).map(|(d, l)| lane_port_channel(d, l)) else {
        return;
    };
    let Some(lane) = find_lane_mut(&mut proj, lane_id) else { return };
    let Some(ctrl) = find_lane_control_mut(lane, control_id) else { return };
    ctrl["value"] = serde_json::json!(value);
    let cc = ctrl.get("ccNumber").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
    drop(proj);
    state.clock.send(ClockCommand::Midi(port, vec![0xB0 | (ch - 1), cc, value]));
    broadcast_snapshot(state);
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
        "message": "Kein Gerät zugewiesen — im Kontextmenü „Gerät …“ wählen, sonst geht der Ton nur an den virtuellen Port.",
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
        "loopMode": "loop",
        "loopCount": 0,
    })
}

fn default_block_for(role: &str) -> Option<serde_json::Value> {
    match role {
        "melody" => Some(demo_melody_block()),
        "beat" => Some(demo_beat_block()),
        "cc" => Some(default_cc_block()),
        "chord" => Some(default_chord_block()),
        "arp" => Some(default_arp_block()),
        "programChange" => Some(default_program_change_block()),
        "patternShift" => Some(default_pattern_shift_block()),
        _ => None,
    }
}

fn demo_melody_block() -> serde_json::Value {
    // Einfache 1-Takt-Bassline in 16 Steps (C2-Grundton).
    let steps = [0u32, 3, 6, 8, 11, 14];
    let semis = [0i32, 0, 7, 0, 3, 7];
    let notes: Vec<serde_json::Value> = steps
        .iter()
        .zip(semis.iter())
        .map(|(s, semi)| {
            serde_json::json!({
                "step": s,
                "lengthSteps": 2,
                "note": 36 + semi,
                "velocity": 100,
            })
        })
        .collect();
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "melody",
        "name": "Bass",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "baseNote": 36,
        "notes": notes,
    })
}

fn demo_beat_block() -> serde_json::Value {
    let line = |name: &str, note: u8, pattern: [u8; 16]| {
        let steps: Vec<serde_json::Value> = pattern
            .iter()
            .map(|v| serde_json::json!({ "velocity": v }))
            .collect();
        serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": name,
            "note": note,
            "muted": false,
            "steps": steps,
        })
    };
    let kick = line("Kick", 36, [110, 0, 0, 0, 110, 0, 0, 0, 110, 0, 0, 0, 110, 0, 0, 0]);
    let snare = line("Snare", 38, [0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0]);
    let hat = line("Hat", 42, [70, 0, 60, 0, 70, 0, 60, 0, 70, 0, 60, 0, 70, 0, 60, 0]);
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "beat",
        "name": "Beat",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "lines": [kick, snare, hat],
    })
}

fn default_cc_block() -> serde_json::Value {
    serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "cc",
        "name": "CC",
        "lengthBars": 1,
        "timeSignature": "4/4",
        "stepsPerBar": 16,
        "ccNumber": 74,
        "outMin": 0,
        "outMax": 127,
        "resolutionPerBar": 16,
        "slewMs": 0,
        "curve": "linear",
        "layers": [{
            "id": uuid::Uuid::new_v4().to_string(),
            "kind": "stepped",
            "enabled": true,
            "combine": "replace",
            "depth": 1,
            "offset": 0,
            "values": vec![0u8; 16],
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
