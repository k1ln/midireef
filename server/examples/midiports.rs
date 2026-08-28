use midir::{MidiInput, MidiOutput};

fn main() {
    let mi = MidiInput::new("scan-in").expect("in");
    println!("INPUTS:");
    for p in mi.ports().iter() {
        if let Ok(n) = mi.port_name(p) {
            println!("  [{n}]");
        }
    }
    let mo = MidiOutput::new("scan-out").expect("out");
    println!("OUTPUTS:");
    for p in mo.ports().iter() {
        if let Ok(n) = mo.port_name(p) {
            println!("  [{n}]");
        }
    }
}
