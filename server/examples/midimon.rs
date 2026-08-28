//! Standalone MIDI monitor: opens every visible MIDI input port and prints
//! every raw incoming message with a timestamp, port name, and hex bytes.
//! Run with: cargo run --example midimon

use std::io::Write;
use std::time::Instant;

use midir::MidiInput;

fn main() {
    let midi_in = MidiInput::new("midimon").expect("MIDI init failed");
    let ports = midi_in.ports();

    if ports.is_empty() {
        eprintln!("No MIDI input ports found.");
        return;
    }

    println!("Listening on {} MIDI input port(s):", ports.len());
    for p in &ports {
        if let Ok(name) = midi_in.port_name(p) {
            println!("  - {name}");
        }
    }
    println!("Turn knobs / press keys now. Ctrl+C to quit.\n");

    let start = Instant::now();
    let mut _conns = Vec::new();

    for p in &ports {
        let Ok(name) = midi_in.port_name(p) else { continue };
        let Ok(input) = MidiInput::new("midimon-port") else { continue };
        let conn_name = name.clone();
        if let Ok(conn) = input.connect(
            p,
            "midimon-in",
            move |_ts, msg, _| {
                // MIDI Clock (F8) fires 24x/beat and would flood the log — skip it.
                if msg.first() == Some(&0xF8) {
                    return;
                }
                let t = start.elapsed().as_secs_f64();
                let hex: Vec<String> = msg.iter().map(|b| format!("{b:02X}")).collect();
                println!("[{t:8.3}s] {conn_name:<28} {}", hex.join(" "));
                let _ = std::io::stdout().flush();
            },
            (),
        ) {
            _conns.push(conn);
        }
    }

    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
