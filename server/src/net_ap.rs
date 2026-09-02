//! WLAN-Access-Point des Pi (Einstellungen → „Wi-Fi access point").
//!
//! Der Pi hat EIN WLAN-Radio: läuft der AP, ist kein WLAN-Uplink mehr möglich.
//! Ein Ethernet-Uplink bleibt und wird von NetworkManager (`ipv4.method
//! shared` → DHCP + NAT + dnsmasq) an die AP-Clients weitergereicht. Clients
//! landen in 10.42.0.0/24, der Pi ist 10.42.0.1 — die UI also unter
//! `http://10.42.0.1:<port>`.
//!
//! Die eigentliche Schaltarbeit macht der privilegierte Helfer
//! `deploy/bin/midireef-net` über `sudo` (eine `sudoers`-Zeile erlaubt exakt
//! dieses Skript passwortlos). Hier steht nur: Persistenz in
//! `<data_dir>/network.json`, Validierung und der Bau des
//! `network.state`-Events.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// Vom Server gehaltener Soll-Zustand des Access-Points. Liegt als
/// `network.json` neben den Projekten, damit der Pi den AP über Reboots hinweg
/// „behält" (siehe `main.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub ap_enabled: bool,
    pub ssid: String,
    /// Leer = offenes Netz (`key-mgmt=none`), sonst WPA2-PSK (8–63 Zeichen).
    pub password: String,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            ap_enabled: false,
            ssid: "MidiReef".into(),
            password: String::new(),
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("network.json")
}

/// Lädt `network.json`; fehlt oder bricht sie, gibt es den Default (AP aus).
pub fn load(data_dir: &Path) -> NetworkConfig {
    match std::fs::read_to_string(config_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!("network.json unlesbar ({e}) — nehme Default (AP aus)");
            NetworkConfig::default()
        }),
        Err(_) => NetworkConfig::default(),
    }
}

pub fn save(data_dir: &Path, cfg: &NetworkConfig) -> std::io::Result<()> {
    std::fs::write(config_path(data_dir), serde_json::to_string_pretty(cfg)?)
}

/// Pfad des privilegierten Helfers. Default `./bin/midireef-net` (relativ zum
/// Arbeitsverzeichnis des Dienstes, auf dem Pi `$PI_DIR`); überschreibbar per
/// `MIDIREEF_NET_HELPER`.
pub fn helper_path() -> PathBuf {
    std::env::var("MIDIREEF_NET_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./bin/midireef-net"))
}

/// Ob die AP-Steuerung auf diesem Host möglich ist — der Helfer muss da sein.
/// Auf dem Mac-Dev-Rechner ist er das nicht; die UI zeigt die Karte dann
/// deaktiviert („Runs only on the Pi").
pub fn supported() -> bool {
    helper_path().is_file()
}

/// Prüft SSID/Passwort, bevor der Helfer bemüht wird. Fehlermeldungen sind
/// für die UI gedacht (deutschsprachig, ganze Sätze).
pub fn validate(cfg: &NetworkConfig) -> Result<(), String> {
    let ssid = cfg.ssid.trim();
    if ssid.is_empty() {
        return Err("Der WLAN-Name darf nicht leer sein.".into());
    }
    if ssid.len() > 32 {
        return Err("Der WLAN-Name darf höchstens 32 Zeichen haben.".into());
    }
    if !cfg.password.is_empty() {
        let n = cfg.password.chars().count();
        if !(8..=63).contains(&n) {
            return Err(
                "Das WLAN-Passwort braucht 8–63 Zeichen (oder lass es leer für ein offenes Netz)."
                    .into(),
            );
        }
    }
    Ok(())
}

/// Bringt den Pi in den durch `cfg` beschriebenen Zustand. Blockiert (startet
/// `sudo`, wartet auf `nmcli`, das die Schnittstelle neu aufsetzt — Sekunden).
/// Aufrufer nutzen `spawn_blocking`.
pub fn apply(cfg: &NetworkConfig) -> Result<(), String> {
    let helper = helper_path();
    if !helper.is_file() {
        return Err(format!("WLAN-Helfer nicht gefunden: {}", helper.display()));
    }

    let mut child = Command::new("sudo")
        .arg("-n")
        .arg(&helper)
        .arg("apply")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("sudo {} ließ sich nicht starten: {e}", helper.display()))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "kein stdin zum Helfer".to_string())?;
        // 3 Zeilen: enabled, ssid, psk — Geheimnisse bewusst NICHT über argv,
        // sonst stünde das WLAN-Passwort in `ps`.
        let payload = format!(
            "{}\n{}\n{}\n",
            if cfg.ap_enabled { "1" } else { "0" },
            cfg.ssid.trim(),
            cfg.password,
        );
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("stdin an den Helfer schreiben: {e}"))?;
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("auf den Helfer warten: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    Err(if err.is_empty() {
        format!("WLAN-Helfer endete mit Fehler (Code {:?})", out.status.code())
    } else {
        err.to_string()
    })
}

/// Fragt den Helfer nach dem Ist-Zustand: `(active, ssid)`. Bei jedem Fehler
/// `(false, "")` — der Aufrufer meldet dann eben „inaktiv". Blockiert
/// (spawnt `sudo`/`nmcli`).
pub fn status() -> (bool, String) {
    let helper = helper_path();
    if !helper.is_file() {
        return (false, String::new());
    }
    let out = match Command::new("sudo")
        .arg("-n")
        .arg(&helper)
        .arg("status")
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (false, String::new()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().next().unwrap_or("");
    let mut parts = line.splitn(2, '\t');
    let state = parts.next().unwrap_or("");
    let ssid = parts.next().unwrap_or("").trim().to_string();
    (state == "active", ssid)
}

/// Baut das `network.state`-Event für die UI. `active` erfragt der Aufrufer
/// vorher via `status()` (nur wenn `supported()`), damit die Karte
/// „läuft"/„läuft nicht" korrekt zeigt. Das Passwort geht bewusst mit zurück —
/// der vertraute Kiosk muss es (und den QR-Code zum Beitreten) anzeigen; wer
/// den AP-Schlüssel nicht kennt, erreicht `:8787` ohnehin nicht.
pub fn state_event(cfg: &NetworkConfig, port: u16, active: bool) -> serde_json::Value {
    serde_json::json!({
        "t": "network.state",
        "supported": supported(),
        "apEnabled": cfg.ap_enabled,
        "ssid": cfg.ssid,
        "password": cfg.password,
        "apAddress": "10.42.0.1",
        "port": port,
        "active": active,
    })
}
