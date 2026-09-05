//! Bildschirmdrehung des Kiosk-Displays (Einstellungen → „Display drehen").
//!
//! Anders als der WLAN-Access-Point (`net_ap.rs`) braucht das kein `sudo`:
//! das Drehen des eigenen Wayland-/X11-Outputs ist eine normale Aktion der
//! Desktop-Sitzung, keine System-Änderung. Der Helfer
//! `deploy/bin/midireef-display` erledigt die Compositor-Erkennung
//! (labwc/Wayland via `wlr-randr`, X11-Fallback via `xrandr`) und schreibt
//! den Wert zusätzlich nach `$HOME/.config/midireef/kiosk-rotation`, damit
//! `kiosk.sh` ihn nach einem Reboot sofort wieder herstellt, bevor der Server
//! läuft. Hier steht nur: Persistenz in `<data_dir>/display.json` und der Bau
//! des `display.state`-Events.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct DisplayConfig {
    pub rotated: bool,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("display.json")
}

/// Lädt `display.json`; fehlt oder bricht sie, gibt es den Default (normal).
pub fn load(data_dir: &Path) -> DisplayConfig {
    match std::fs::read_to_string(config_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!("display.json unlesbar ({e}) — nehme Default (normal)");
            DisplayConfig::default()
        }),
        Err(_) => DisplayConfig::default(),
    }
}

pub fn save(data_dir: &Path, cfg: &DisplayConfig) -> std::io::Result<()> {
    std::fs::write(config_path(data_dir), serde_json::to_string_pretty(cfg)?)
}

/// Pfad des Helfers. Default `./bin/midireef-display` (relativ zum
/// Arbeitsverzeichnis des Dienstes, auf dem Pi `$PI_DIR`); überschreibbar per
/// `MIDIREEF_DISPLAY_HELPER`.
pub fn helper_path() -> PathBuf {
    std::env::var("MIDIREEF_DISPLAY_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./bin/midireef-display"))
}

/// Ob die Drehung auf diesem Host möglich ist — der Helfer muss da sein.
/// Auf dem Mac-Dev-Rechner ist er das nicht; die UI zeigt die Karte dann
/// deaktiviert („Runs only on the Pi").
pub fn supported() -> bool {
    helper_path().is_file()
}

/// Dreht den Kiosk-Output live (blockiert: startet den Helfer, der
/// `wlr-randr` bzw. `xrandr` ruft — Millisekunden). Aufrufer nutzen
/// `spawn_blocking`.
pub fn apply(cfg: &DisplayConfig) -> Result<(), String> {
    let helper = helper_path();
    if !helper.is_file() {
        return Err(format!("Display-Helfer nicht gefunden: {}", helper.display()));
    }
    let angle = if cfg.rotated { "180" } else { "0" };
    let out = Command::new(&helper)
        .arg(angle)
        .output()
        .map_err(|e| format!("{} ließ sich nicht starten: {e}", helper.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    Err(if err.is_empty() {
        format!("Display-Helfer endete mit Fehler (Code {:?})", out.status.code())
    } else {
        err.to_string()
    })
}

/// Baut das `display.state`-Event für die UI.
pub fn state_event(cfg: &DisplayConfig) -> serde_json::Value {
    serde_json::json!({
        "t": "display.state",
        "supported": supported(),
        "rotated": cfg.rotated,
    })
}
