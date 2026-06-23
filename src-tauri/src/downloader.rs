use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

// ── Public types shared with commands ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfoResponse {
    pub id: String,
    pub title: String,
    pub thumbnail: String,
    pub duration: String,
    pub resolutions: Vec<String>,
    pub is_playlist: bool,
    pub playlist_count: Option<usize>,
    pub videos: Option<Vec<PlaylistVideoResponse>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistVideoResponse {
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadParams {
    pub title: String,
    pub resolution: String,
    pub output_type: String,   // "video" | "audio"
    pub container: String,     // "mp4" | "mkv"
    pub audio_format: String,  // "mp3" | "m4a"
    pub output_path: String,
}

// ── Internal event payloads ───────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ProgressPayload {
    pub id: String,
    pub percent: f64,
    pub speed: String,
}

#[derive(Serialize, Clone)]
pub struct StatusPayload {
    pub id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompletePayload {
    pub id: String,
    pub output_path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ErrorPayload {
    pub id: String,
    pub message: String,
}

// ── yt-dlp path resolution ────────────────────────────────────────────────────

pub fn resolve_ytdlp(app: &AppHandle) -> PathBuf {
    // In debug builds always use the source binary — Tauri copies the exe into
    // target/debug/ where Windows marks it as blocked (PyInstaller PKG error).
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("yt-dlp.exe");
        if dev.exists() {
            return dev;
        }
    }

    // Release: use the resource bundled alongside the installed app
    #[cfg(not(debug_assertions))]
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("yt-dlp.exe");
        if p.exists() {
            return p;
        }
    }

    let _ = app;
    PathBuf::from("yt-dlp")
}

// ── Video / playlist info ─────────────────────────────────────────────────────

pub async fn get_video_info(url: &str, ytdlp: &Path) -> Result<VideoInfoResponse, String> {
    let is_playlist = url.contains("list=")
        && !url.contains("/watch?v=")
        && !url.contains("youtu.be/");

    if is_playlist {
        get_playlist_info(url, ytdlp).await
    } else {
        get_single_video_info(url, ytdlp).await
    }
}

async fn get_single_video_info(url: &str, ytdlp: &Path) -> Result<VideoInfoResponse, String> {
    let output = tokio::process::Command::new(ytdlp)
        .args(["--dump-json", "--no-playlist", "--no-warnings", url])
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {err}"));
    }

    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("JSON parse error: {e}"))?;

    let id = json["id"].as_str().unwrap_or("").to_string();
    let title = json["title"].as_str().unwrap_or("Untitled").to_string();
    let duration = format_duration(json["duration"].as_f64().unwrap_or(0.0) as u64);
    let thumbnail = best_thumbnail(&json);

    // Collect progressive (combined stream) resolutions
    let mut resolutions: Vec<String> = json["formats"]
        .as_array()
        .map(|fmts| {
            let mut seen = std::collections::HashSet::new();
            fmts.iter()
                .filter(|f| {
                    let has_video = f["vcodec"].as_str().unwrap_or("none") != "none";
                    let has_audio = f["acodec"].as_str().unwrap_or("none") != "none";
                    has_video && has_audio
                })
                .filter_map(|f| {
                    let h = f["height"].as_u64()?;
                    let label = format!("{}p", h);
                    if seen.insert(label.clone()) { Some(label) } else { None }
                })
                .collect()
        })
        .unwrap_or_default();

    resolutions.sort_by(|a, b| {
        let a_n: u32 = a.trim_end_matches('p').parse().unwrap_or(0);
        let b_n: u32 = b.trim_end_matches('p').parse().unwrap_or(0);
        b_n.cmp(&a_n)
    });

    Ok(VideoInfoResponse {
        id,
        title,
        thumbnail,
        duration,
        resolutions,
        is_playlist: false,
        playlist_count: None,
        videos: None,
    })
}

async fn get_playlist_info(url: &str, ytdlp: &Path) -> Result<VideoInfoResponse, String> {
    let output = tokio::process::Command::new(ytdlp)
        .args([
            "--dump-json",
            "--flat-playlist",
            "--no-warnings",
            url,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {err}"));
    }

    // Each line is a JSON object for one video
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut videos: Vec<PlaylistVideoResponse> = Vec::new();
    let mut playlist_title = "Playlist".to_string();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v): Result<Value, _> = serde_json::from_str(line) else {
            continue;
        };

        // The last entry might be the playlist itself
        if v["_type"].as_str() == Some("playlist") {
            if let Some(t) = v["title"].as_str() {
                if !t.is_empty() {
                    playlist_title = t.to_string();
                }
            }
            continue;
        }

        let id = v["id"].as_str().unwrap_or("").to_string();
        let title = v["title"].as_str().unwrap_or("Untitled").to_string();
        let url = v["url"]
            .as_str()
            .map(|u| u.to_string())
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", id));
        let thumbnail = v["thumbnails"]
            .as_array()
            .and_then(|ts| ts.last())
            .and_then(|t| t["url"].as_str())
            .map(|s| s.to_string());

        if !id.is_empty() {
            videos.push(PlaylistVideoResponse { id, title, url, thumbnail });
        }
    }

    let count = videos.len();
    let first_thumb = videos.first().and_then(|v| v.thumbnail.clone()).unwrap_or_default();

    Ok(VideoInfoResponse {
        id: String::new(),
        title: playlist_title,
        thumbnail: first_thumb,
        duration: String::new(),
        resolutions: vec![],
        is_playlist: true,
        playlist_count: Some(count),
        videos: Some(videos),
    })
}

// ── Download ──────────────────────────────────────────────────────────────────

pub async fn start_download(
    id: String,
    url: String,
    params: DownloadParams,
    ytdlp: PathBuf,
    cancel_flag: Arc<AtomicBool>,
    app: AppHandle,
) {
    app.emit("download:started", StatusPayload { id: id.clone() }).ok();

    match run_download(&id, &url, &params, &ytdlp, &cancel_flag, &app).await {
        Ok(output_path) => {
            if cancel_flag.load(Ordering::Relaxed) {
                app.emit("download:cancelled", StatusPayload { id }).ok();
            } else {
                app.emit("download:complete", CompletePayload { id, output_path }).ok();
            }
        }
        Err(msg) => {
            app.emit("download:error", ErrorPayload { id, message: msg }).ok();
        }
    }
}

async fn run_download(
    id: &str,
    url: &str,
    params: &DownloadParams,
    ytdlp: &Path,
    cancel_flag: &Arc<AtomicBool>,
    app: &AppHandle,
) -> Result<Option<String>, String> {
    // Use an ASCII-safe temp name so path capture is encoding-proof.
    // We rename to the sanitized title after the download completes.
    let temp_stem = format!("ytdl_tmp_{id}");

    let mut args: Vec<String> = vec![
        "--newline".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--progress-template".into(),
        "PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s".into(),
        "-o".into(),
        format!("{}/{}.%(ext)s", params.output_path, temp_stem),
    ];

    if params.output_type == "audio" {
        args.push("-x".into());
        args.push("--audio-format".into());
        args.push(params.audio_format.clone());
        // Prefer m4a source to avoid unnecessary re-encoding
        args.push("-f".into());
        args.push("bestaudio[ext=m4a]/bestaudio".into());
    } else {
        let ffmpeg_ok = crate::ffmpeg::check_ffmpeg();
        let format = build_video_format(&params.resolution, ffmpeg_ok);
        args.push("-f".into());
        args.push(format);

        if ffmpeg_ok {
            args.push("--merge-output-format".into());
            args.push(params.container.clone());
        }
    }

    args.push("--progress".into());
    args.push(url.to_string());

    let mut child = tokio::process::Command::new(ytdlp)
        .args(&args)
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Drain stderr in background so it doesn't block
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut last_error = String::new();
    let mut stdout_lines = BufReader::new(stdout).lines();

    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut output_path: Option<String> = None;

    loop {
        tokio::select! {
            line = stdout_lines.next_line(), if !stdout_done => {
                match line {
                    Ok(Some(l)) => {
                        eprintln!("[stdout] {l}");
                        if let Some(path) = parse_output_path(&l) {
                            eprintln!("[path] captured: {path}");
                            output_path = Some(path);
                        }
                        handle_progress_line(&l, id, app);
                    }
                    _ => stdout_done = true,
                }
            }
            line = stderr_lines.next_line(), if !stderr_done => {
                match line {
                    Ok(Some(l)) => {
                        eprintln!("[stderr] {l}");
                        if let Some(path) = parse_output_path(&l) {
                            eprintln!("[path] captured (stderr): {path}");
                            output_path = Some(path);
                        }
                        if !handle_progress_line(&l, id, app) {
                            last_error = l;
                        }
                    }
                    _ => stderr_done = true,
                }
            }
        }

        if cancel_flag.load(Ordering::Relaxed) {
            child.kill().await.ok();
            return Ok(None);
        }

        if stdout_done && stderr_done {
            break;
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(if last_error.is_empty() {
            "yt-dlp exited with an error".to_string()
        } else {
            last_error
        });
    }

    // Rename temp file to sanitized title
    if let Some(ref temp_path) = output_path {
        let temp_file = std::path::Path::new(temp_path);
        if let Some(ext) = temp_file.extension().and_then(|e| e.to_str()) {
            let safe_name = sanitize_filename(&params.title);
            let final_path = unique_path(&params.output_path, &safe_name, ext);
            if let Err(e) = tokio::fs::rename(temp_path, &final_path).await {
                eprintln!("[rename] failed: {e}");
            } else {
                output_path = Some(final_path);
            }
        }
    }

    Ok(output_path)
}

fn parse_output_path(line: &str) -> Option<String> {
    // Merged (ffmpeg) — final merged path
    if let Some(rest) = line.strip_prefix("[Merger] Merging formats into ") {
        return Some(rest.trim().trim_matches('"').to_string());
    }
    // Audio extraction
    if let Some(rest) = line.strip_prefix("[ExtractAudio] Destination: ") {
        return Some(rest.trim().to_string());
    }
    // Direct download
    if let Some(rest) = line.strip_prefix("[download] Destination: ") {
        return Some(rest.trim().to_string());
    }
    // Already downloaded: "[download] /path/file.ext has already been downloaded"
    if let Some(rest) = line.strip_prefix("[download] ") {
        if let Some(path) = rest.strip_suffix(" has already been downloaded") {
            return Some(path.trim().to_string());
        }
    }
    None
}

fn handle_progress_line(line: &str, id: &str, app: &AppHandle) -> bool {
    let Some(rest) = line.strip_prefix("PROG|") else { return false; };
    // Format: downloaded_bytes|total_bytes|total_bytes_estimate|speed
    let parts: Vec<&str> = rest.splitn(5, '|').collect();

    let downloaded = parts.first().and_then(|s| s.trim().parse::<f64>().ok());
    let total = parts.get(1).and_then(|s| s.trim().parse::<f64>().ok())
        .or_else(|| parts.get(2).and_then(|s| s.trim().parse::<f64>().ok()));

    let percent = match (downloaded, total) {
        (Some(d), Some(t)) if t > 0.0 => (d / t * 100.0).min(100.0),
        _ => -1.0,
    };

    let speed = parts.get(3)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(format_speed)
        .unwrap_or_default();

    eprintln!("[prog] percent={percent:.1} speed={speed}");
    app.emit("download:progress", ProgressPayload { id: id.to_string(), percent, speed }).ok();
    true
}

fn format_speed(bps: f64) -> String {
    const MIB: f64 = 1_048_576.0;
    const KIB: f64 = 1_024.0;
    if bps >= MIB { format!("{:.1} MiB/s", bps / MIB) }
    else if bps >= KIB { format!("{:.1} KiB/s", bps / KIB) }
    else { format!("{:.0} B/s", bps) }
}

fn sanitize_filename(name: &str) -> String {
    let result: String = name.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let result = result.trim_end_matches(|c| c == ' ' || c == '.').to_string();
    if result.is_empty() {
        return "download".to_string();
    }
    // Limit to 200 chars to leave room for counter suffix + extension
    result.chars().take(200).collect()
}

fn unique_path(dir: &str, stem: &str, ext: &str) -> String {
    let candidate = format!("{dir}/{stem}.{ext}");
    if !std::path::Path::new(&candidate).exists() {
        return candidate;
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{dir}/{stem} ({n}).{ext}");
        if !std::path::Path::new(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

fn build_video_format(resolution: &str, ffmpeg_available: bool) -> String {
    if ffmpeg_available {
        match resolution {
            "best" => "bestvideo+bestaudio/best".to_string(),
            r => {
                let h = r.trim_end_matches('p');
                format!("bestvideo[height<={h}]+bestaudio/best[height<={h}]")
            }
        }
    } else {
        // Progressive (combined) streams only — no ffmpeg needed
        match resolution {
            "best" => "best[vcodec!=none][acodec!=none]/best".to_string(),
            r => {
                let h = r.trim_end_matches('p');
                format!("best[height<={h}][vcodec!=none][acodec!=none]/best[height<={h}]")
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn format_duration(seconds: u64) -> String {
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{}:{:02}", m, s)
    }
}

fn best_thumbnail(json: &Value) -> String {
    // Prefer the explicit "thumbnail" field, fall back to thumbnails array
    if let Some(t) = json["thumbnail"].as_str() {
        return t.to_string();
    }
    json["thumbnails"]
        .as_array()
        .and_then(|ts| {
            ts.iter()
                .filter_map(|t| t["url"].as_str())
                .last()
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}
