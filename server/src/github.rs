//! GitHub-Backup (Einstellungen → „GitHub backup"): Personal-Access-Token +
//! Ziel-Repo, ein manueller „Push"-Knopf schreibt jede gespeicherte
//! Projekt-Datei über die Contents API in den Repo (ein Commit je Datei —
//! einfacher als die Git-Data-API und für die paar Dutzend Projekte, um die
//! es hier geht, allemal schnell genug).
//!
//! Persistiert als `<data_dir>/github.json`, gleiches Muster wie
//! `net_ap::NetworkConfig`. Das Token geht NIE an die UI zurück (auch nicht
//! maskiert) — `state_event` meldet nur `configured: bool`.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConfig {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub repo: String,
    /// Leer = Standard-Branch des Repos.
    #[serde(default)]
    pub branch: String,
}

impl GithubConfig {
    pub fn configured(&self) -> bool {
        !self.token.is_empty() && !self.owner.is_empty() && !self.repo.is_empty()
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("github.json")
}

/// Lädt `github.json`; fehlt oder bricht sie, gibt es den leeren Default
/// (nicht konfiguriert).
pub fn load(data_dir: &Path) -> GithubConfig {
    match std::fs::read_to_string(config_path(data_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => GithubConfig::default(),
    }
}

pub fn save(data_dir: &Path, cfg: &GithubConfig) -> std::io::Result<()> {
    std::fs::write(config_path(data_dir), serde_json::to_string_pretty(cfg)?)
}

/// An die UI gemeldeter Zustand — bewusst OHNE Token.
pub fn state_event(cfg: &GithubConfig) -> serde_json::Value {
    serde_json::json!({
        "t": "github.config",
        "configured": cfg.configured(),
        "owner": cfg.owner,
        "repo": cfg.repo,
        "branch": cfg.branch,
    })
}

pub struct PushSummary {
    pub pushed: usize,
    pub failed: Vec<(String, String)>,
}

const USER_AGENT: &str = "midireef-server";

/// Schreibt jede `<data_dir>/projects/*.json` nach `projects/<id>.json` im
/// konfigurierten Repo. Läuft Datei für Datei durch — ein Fehler bei einer
/// bricht die anderen nicht ab, `PushSummary` sammelt beides.
pub async fn push_all_projects(
    cfg: &GithubConfig,
    data_dir: &Path,
) -> Result<PushSummary, String> {
    if !cfg.configured() {
        return Err("GitHub is not configured yet — set token, owner and repo first.".into());
    }
    let projects = crate::state::list_projects_in(data_dir);
    if projects.is_empty() {
        return Err("No saved projects to push yet.".into());
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("building HTTP client: {e}"))?;

    let mut pushed = 0usize;
    let mut failed = Vec::new();

    for p in &projects {
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(id);
        if id.is_empty() {
            continue;
        }
        let path = data_dir.join("projects").join(format!("{id}.json"));
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                failed.push((name.to_string(), format!("reading file: {e}")));
                continue;
            }
        };
        match push_one_file(&client, cfg, &format!("projects/{id}.json"), &bytes, name).await {
            Ok(()) => pushed += 1,
            Err(e) => failed.push((name.to_string(), e)),
        }
    }

    Ok(PushSummary { pushed, failed })
}

fn api_url(cfg: &GithubConfig, repo_path: &str) -> String {
    format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        cfg.owner, cfg.repo, repo_path
    )
}

async fn push_one_file(
    client: &reqwest::Client,
    cfg: &GithubConfig,
    repo_path: &str,
    bytes: &[u8],
    project_name: &str,
) -> Result<(), String> {
    let url = api_url(cfg, repo_path);

    // 1) Steht schon eine Version da? Ihre `sha` braucht der Update-PUT —
    //    ohne sie lehnt GitHub mit 409/422 als „conflict" ab.
    let mut get_req = client
        .get(&url)
        .bearer_auth(&cfg.token)
        .header("Accept", "application/vnd.github+json");
    if !cfg.branch.is_empty() {
        get_req = get_req.query(&[("ref", cfg.branch.as_str())]);
    }
    let existing_sha = match get_req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            body.get("sha")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        }
        Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => None,
        Ok(resp) => return Err(api_error(resp).await),
        Err(e) => return Err(format!("network error: {e}")),
    };

    // 2) Anlegen/Aktualisieren.
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut body = serde_json::json!({
        "message": format!("MidiReef backup: {project_name}"),
        "content": content_b64,
    });
    if let Some(sha) = existing_sha {
        body["sha"] = serde_json::Value::String(sha);
    }
    if !cfg.branch.is_empty() {
        body["branch"] = serde_json::Value::String(cfg.branch.clone());
    }

    let put_resp = client
        .put(&url)
        .bearer_auth(&cfg.token)
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    if put_resp.status().is_success() {
        Ok(())
    } else {
        Err(api_error(put_resp).await)
    }
}

async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let msg = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    if msg.is_empty() {
        format!("GitHub API error ({status})")
    } else {
        format!("{msg} ({status})")
    }
}
