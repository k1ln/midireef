//! Trimmed, vendored equivalent of the (tiny, MIT) `coremidi-hotplug-notification`
//! crate — inlined directly since the actual need is ~50 lines of CoreMIDI/
//! CFRunLoop plumbing, not a whole extra dependency.
//!
//! CoreMIDI binds the thread that will receive device add/remove
//! notifications to whichever thread creates the *first* CoreMIDI client in
//! the process — even if that client never asked for notifications. `midir`'s
//! `MidiInput`/`MidiOutput::new` create a client without a notification
//! callback and without an active CFRunLoop; if that happens to be the first
//! contact, the process's view of externally-attached devices freezes at
//! whatever was true at startup, forever — a device plugged in afterwards
//! never appears in any later `.ports()` scan, even a brand-new one. `init()`
//! must therefore run before any other CoreMIDI/`midir` call in the process.

use std::sync::mpsc;
use std::time::Duration;

use core_foundation::runloop::CFRunLoop;
use coremidi::{Client, Notification};

/// Creates a CoreMIDI client with a notification callback on a dedicated
/// thread, then keeps that thread's CFRunLoop running for the life of the
/// process — the combination CoreMIDI actually requires to deliver hotplug
/// notifications (see module docs).
///
/// To confirm this is genuinely wired up rather than silently inert, briefly
/// creates a throwaway virtual source and waits for the resulting
/// add-notification to round-trip back through the callback before
/// continuing; the virtual source is dropped immediately after (which
/// unregisters it — `coremidi::VirtualSource` disposes the endpoint on
/// `Drop`), so nothing lingers as a fake system-wide MIDI port. The run loop
/// starts regardless of whether the check succeeded (best-effort — partial
/// function is better than none), but a failed check is reported so the
/// caller can log it.
pub fn init() -> Result<(), String> {
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(0);

    std::thread::Builder::new()
        .name("midireef-coremidi-hotplug".into())
        .spawn(move || {
            let (notified_tx, notified_rx) = mpsc::channel::<()>();

            let client = match Client::new_with_notifications("MidiReef Hotplug", move |_: &Notification| {
                let _ = notified_tx.send(());
            }) {
                Ok(client) => client,
                Err(status) => {
                    let _ = ready_tx.send(Err(format!("MIDIClientCreate fehlgeschlagen (OSStatus {status})")));
                    return;
                }
            };

            let sanity_check = match client.virtual_source("midireef-hotplug-sanity-check") {
                Ok(probe) => {
                    let confirmed = notified_rx.recv_timeout(Duration::from_secs(1)).is_ok();
                    drop(probe);
                    if confirmed {
                        Ok(())
                    } else {
                        Err("Sanity-Check-Benachrichtigung nicht innerhalb 1s erhalten — \
                             vermutlich wurde bereits vorher ein anderer CoreMIDI-Client \
                             im Prozess erzeugt"
                            .to_string())
                    }
                }
                Err(status) => Err(format!("Virtueller Test-Port fehlgeschlagen (OSStatus {status})")),
            };
            let _ = ready_tx.send(sanity_check);

            // Client absichtlich nicht droppen (sonst verstummen die
            // Benachrichtigungen wieder) — bleibt bis Prozessende im Scope,
            // da `run_current()` nie zurückkehrt.
            CFRunLoop::run_current();
            let _ = client;
        })
        .expect("coremidi hotplug thread");

    ready_rx.recv().map_err(|_| "Hotplug-Thread beendete sich unerwartet".to_string())?
}
