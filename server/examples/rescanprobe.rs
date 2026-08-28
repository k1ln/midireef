// Minimal, isolated probe — no CFRunLoop thread, no other CoreMIDI clients,
// nothing from the server. Purpose: find out whether a device plugged in
// AFTER this process starts ever shows up in a completely fresh port scan,
// independent of anything midireef-server itself does.
//
// Run it, wait for a few polls with the device unplugged, then plug it in
// (or unplug/replug it) and watch whether it appears in "fresh out"/"fresh in".
use std::time::Duration;

fn main() {
    for i in 0.. {
        let out = midir::MidiOutput::new("probe-out").expect("out client");
        let out_names: Vec<String> =
            out.ports().iter().filter_map(|p| out.port_name(p).ok()).collect();

        let inp = midir::MidiInput::new("probe-in").expect("in client");
        let in_names: Vec<String> =
            inp.ports().iter().filter_map(|p| inp.port_name(p).ok()).collect();

        println!("poll {i}: fresh out={out_names:?} fresh in={in_names:?}");
        std::thread::sleep(Duration::from_secs(1));
    }
}
