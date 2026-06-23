mod config;
mod downloader;
mod ffmpeg;

use config::{AppConfig, load_config, save_config};
use downloader::{DownloadParams, VideoInfoResponse};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex, Semaphore};

pub struct AppState {
    pub downloads: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub semaphore: Arc<Semaphore>,
    pub config: Arc<Mutex<AppConfig>>,
    pub ffmpeg_available: bool,
    pub ytdlp_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    default_output_path: String,
    ffmpeg_available: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigInput {
    default_output_path: String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn check_ffmpeg() -> bool {
    ffmpeg::check_ffmpeg()
}

#[tauri::command]
async fn get_video_info(url: String, state: State<'_, AppState>) -> Result<VideoInfoResponse, String> {
    downloader::get_video_info(&url, &state.ytdlp_path).await
}

#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String> {
    let cfg = state.config.lock().await;
    Ok(ConfigResponse {
        default_output_path: cfg.default_output_path.clone(),
        ffmpeg_available: state.ffmpeg_available,
    })
}

#[tauri::command]
async fn set_config(
    input: SetConfigInput,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut cfg = state.config.lock().await;
    cfg.default_output_path = input.default_output_path;
    save_config(&app, &cfg)
}

#[tauri::command]
async fn start_download(
    id: String,
    url: String,
    params: DownloadParams,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let downloads = state.downloads.clone();
    let semaphore = state.semaphore.clone();
    let ytdlp = state.ytdlp_path.clone();
    let cancel_flag = Arc::new(AtomicBool::new(false));

    downloads
        .lock()
        .await
        .insert(id.clone(), cancel_flag.clone());

    tokio::spawn(async move {
        let _permit = semaphore
            .acquire()
            .await
            .expect("semaphore closed unexpectedly");

        downloader::start_download(id.clone(), url, params, ytdlp, cancel_flag, app).await;

        downloads.lock().await.remove(&id);
    });

    Ok(())
}

#[tauri::command]
async fn cancel_download(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let map = state.downloads.lock().await;
    if let Some(flag) = map.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn get_active_downloads(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.downloads.lock().await.keys().cloned().collect())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Option<String>>();

    app.dialog().file().pick_folder(move |folder| {
        let path = folder.map(|f| f.to_string());
        let _ = tx.send(path);
    });

    rx.await.ok().flatten()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = load_config(app.handle());
            let ffmpeg_ok = ffmpeg::check_ffmpeg();
            let ytdlp_path = downloader::resolve_ytdlp(app.handle());

            app.manage(AppState {
                downloads: Arc::new(Mutex::new(HashMap::new())),
                semaphore: Arc::new(Semaphore::new(2)),
                config: Arc::new(Mutex::new(cfg)),
                ffmpeg_available: ffmpeg_ok,
                ytdlp_path,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            get_video_info,
            get_config,
            set_config,
            start_download,
            cancel_download,
            get_active_downloads,
            pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
