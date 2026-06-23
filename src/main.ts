import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import type {
  VideoInfoResponse,
  DownloadParams,
  DownloadItem,
  ConfigResponse,
  ProgressPayload,
  StatusPayload,
  CompletePayload,
  ErrorPayload,
} from "./types";

// ── State ────────────────────────────────────────────────────────────────────

let config: ConfigResponse = { defaultOutputPath: "", ffmpegAvailable: false };
const items = new Map<string, DownloadItem>();
let pendingInfo: VideoInfoResponse | null = null;

// Frontend download queue — maintains strict ordering
interface QueueJob { id: string; url: string; params: DownloadParams }
const downloadQueue: QueueJob[] = [];
let activeCount = 0;
const MAX_CONCURRENT = 2;

let pendingAmbiguousUrl: string | null = null;

let popoverOutputType: "video" | "audio" = "video";
let popoverResolution = "best";
let popoverContainer: "mp4" | "mkv" = "mp4";
let popoverAudioFormat: "mp3" | "m4a" = "m4a";

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function show(el: HTMLElement) {
  el.classList.remove("hidden");
}
function hide(el: HTMLElement) {
  el.classList.add("hidden");
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  config = await invoke<ConfigResponse>("get_config");

  $("output-path").setAttribute("value", config.defaultOutputPath);
  ($ <HTMLInputElement>("output-path")).value = config.defaultOutputPath;

  if (!config.ffmpegAvailable) {
    show($("banner"));
    disableFfmpegOptions();
  }

  bindUrlBar();
  bindDisambig();
  bindPopover();
  bindBanner();
  bindClearMenu();
  await bindEvents();
  await loadQueue();
}

// ── URL bar ───────────────────────────────────────────────────────────────────

function bindUrlBar() {
  const input = $<HTMLInputElement>("url-input");
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const url = input.value.trim();
    if (!url) return;
    await handleUrlSubmit(url);
  });
}

async function handleUrlSubmit(url: string) {
  // URL has both a video and a playlist — ask the user which they want
  if (url.includes("/watch?v=") && url.includes("list=")) {
    pendingAmbiguousUrl = url;
    show($("disambig-overlay"));
    return;
  }
  await fetchAndOpenPopover(url);
}

async function fetchAndOpenPopover(url: string) {
  const input = $<HTMLInputElement>("url-input");
  const spinner = $("url-spinner");
  const errEl = $("url-error");

  input.disabled = true;
  input.classList.remove("url-error");
  hide(errEl);
  show(spinner);

  try {
    const info = await invoke<VideoInfoResponse>("get_video_info", { url });
    pendingInfo = info;
    openPopover(info);
    input.value = "";
  } catch (e: unknown) {
    input.classList.add("url-error");
    const raw = String(e);
    const msg = extractErrorMessage(raw);
    errEl.textContent = msg;
    show(errEl);
    setTimeout(() => {
      input.classList.remove("url-error");
      hide(errEl);
    }, 6000);
  } finally {
    input.disabled = false;
    input.focus();
    hide(spinner);
  }
}

function bindDisambig() {
  const closeDisambig = () => {
    pendingAmbiguousUrl = null;
    hide($("disambig-overlay"));
    $<HTMLInputElement>("url-input").focus();
  };

  $("disambig-video-btn").addEventListener("click", async () => {
    const url = pendingAmbiguousUrl!;
    closeDisambig();
    await fetchAndOpenPopover(url);
  });

  $("disambig-playlist-btn").addEventListener("click", async () => {
    const url = pendingAmbiguousUrl!;
    closeDisambig();
    const match = url.match(/[?&]list=([^&]+)/);
    const playlistUrl = match
      ? `https://www.youtube.com/playlist?list=${match[1]}`
      : url;
    await fetchAndOpenPopover(playlistUrl);
  });

  $("disambig-cancel").addEventListener("click", closeDisambig);
  $("disambig-overlay").addEventListener("click", (e) => {
    if (e.target === $("disambig-overlay")) closeDisambig();
  });
}

function extractErrorMessage(raw: string): string {
  // Tauri wraps the Rust error string — strip boilerplate
  const trimmed = raw.replace(/^Error invoking remote method '[^']+': /, "").trim();
  // If yt-dlp wrote a useful line, surface it
  const ytdlpMatch = trimmed.match(/ERROR:.*$/m);
  if (ytdlpMatch) return ytdlpMatch[0].replace(/^ERROR:\s*/, "");
  // Remove "yt-dlp error:" prefix we add
  return trimmed.replace(/^yt-dlp error:\s*/i, "").split("\n")[0] || "Could not fetch video info.";
}

// ── Popover ───────────────────────────────────────────────────────────────────

function openPopover(info: VideoInfoResponse) {
  // Thumbnail
  const thumb = $<HTMLImageElement>("popover-thumb");
  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    show(thumb);
  } else {
    hide(thumb);
  }

  // Title + subtitle (editable input)
  ($<HTMLInputElement>("popover-title")).value = info.title;
  const sub = $("popover-subtitle");
  if (info.isPlaylist && info.playlistCount) {
    sub.textContent = `Playlist — ${info.playlistCount} video${info.playlistCount !== 1 ? "s" : ""}`;
    show(sub);
  } else if (info.duration) {
    sub.textContent = info.duration;
    show(sub);
  } else {
    hide(sub);
  }

  // Populate resolution options
  const sel = $<HTMLSelectElement>("resolution-select");
  sel.innerHTML = "";

  const resolutions = info.resolutions.length
    ? info.resolutions
    : ["720p", "480p", "360p"];

  const bestOption = document.createElement("option");
  bestOption.value = "best";
  bestOption.textContent = "Best available";
  sel.appendChild(bestOption);

  for (const r of resolutions) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    // Disable high-res options when ffmpeg is missing
    if (!config.ffmpegAvailable && isHighRes(r)) {
      opt.disabled = true;
      opt.textContent += " (needs ffmpeg)";
    }
    sel.appendChild(opt);
  }

  popoverResolution = "best";
  sel.value = "best";

  // Reset toggles
  setOutputType("video");
  setContainer("mp4");
  setAudioFormat("m4a");

  // Output path
  ($<HTMLInputElement>("output-path")).value = config.defaultOutputPath;

  // Index checkbox — only relevant for playlists
  ($<HTMLInputElement>("prepend-index-check")).checked = false;
  if (info.isPlaylist) { show($("index-row")); } else { hide($("index-row")); }

  show($("popover-overlay"));
}

function closePopover() {
  hide($("popover-overlay"));
  pendingInfo = null;
}

function bindPopover() {
  $("popover-close").addEventListener("click", closePopover);
  $("cancel-popover-btn").addEventListener("click", closePopover);
  $("popover-overlay").addEventListener("click", (e) => {
    if (e.target === $("popover-overlay")) closePopover();
  });

  // Output type toggle
  bindToggleGroup("output-type-toggle", (val) => {
    setOutputType(val as "video" | "audio");
  });

  // Container toggle
  bindToggleGroup("container-toggle", (val) => {
    popoverContainer = val as "mp4" | "mkv";
  });

  // Audio format toggle
  bindToggleGroup("audio-format-toggle", (val) => {
    popoverAudioFormat = val as "mp3" | "m4a";
  });

  // Resolution select
  $<HTMLSelectElement>("resolution-select").addEventListener("change", (e) => {
    popoverResolution = (e.target as HTMLSelectElement).value;
  });

  // Browse button
  $("browse-btn").addEventListener("click", async () => {
    const folder = await invoke<string | null>("pick_folder");
    if (folder) {
      ($<HTMLInputElement>("output-path")).value = folder;
    }
  });

  // Add to queue
  $("add-queue-btn").addEventListener("click", addToQueue);
}

function bindToggleGroup(id: string, onChange: (val: string) => void) {
  const group = $(id);
  group.querySelectorAll<HTMLButtonElement>(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      group
        .querySelectorAll(".toggle-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.value ?? "");
    });
  });
}

function setOutputType(type: "video" | "audio") {
  popoverOutputType = type;

  const resRow = $("resolution-row");
  const containerRow = $("container-row");
  const audioRow = $("audio-format-row");

  if (type === "video") {
    show(resRow);
    show(containerRow);
    hide(audioRow);
  } else {
    hide(resRow);
    hide(containerRow);
    show(audioRow);
  }

  // Sync toggle button active state
  $("output-type-toggle")
    .querySelectorAll<HTMLButtonElement>(".toggle-btn")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === type);
    });
}

function setContainer(c: "mp4" | "mkv") {
  popoverContainer = c;
  $("container-toggle")
    .querySelectorAll<HTMLButtonElement>(".toggle-btn")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === c);
      if (btn.dataset.value === "mkv" && !config.ffmpegAvailable) {
        btn.disabled = true;
        btn.title = "Requires ffmpeg";
      }
    });
}

function setAudioFormat(f: "mp3" | "m4a") {
  popoverAudioFormat = f;
  $("audio-format-toggle")
    .querySelectorAll<HTMLButtonElement>(".toggle-btn")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === f);
      if (btn.dataset.value === "mp3" && !config.ffmpegAvailable) {
        btn.disabled = true;
        btn.title = "Requires ffmpeg";
      }
    });
}

function isHighRes(r: string) {
  const n = parseInt(r);
  return !isNaN(n) && n > 720;
}

function disableFfmpegOptions() {
  // Will be applied when popover opens — see setContainer / setAudioFormat
}

// ── Add to queue ──────────────────────────────────────────────────────────────

function addToQueue() {
  if (!pendingInfo) return;
  const outputPath = ($<HTMLInputElement>("output-path")).value;

  const editedTitle = ($<HTMLInputElement>("popover-title")).value.trim() || pendingInfo.title;

  const params: DownloadParams = {
    title: editedTitle,
    resolution: popoverResolution,
    outputType: popoverOutputType,
    container: popoverContainer,
    audioFormat: popoverAudioFormat,
    outputPath,
  };

  const prependIndex = ($<HTMLInputElement>("prepend-index-check")).checked;

  if (pendingInfo.isPlaylist && pendingInfo.videos) {
    const total = pendingInfo.videos.length;
    const pad = total >= 100 ? 3 : total >= 10 ? 2 : 1;
    for (let i = 0; i < total; i++) {
      const v = pendingInfo.videos[i];
      const fileTitle = prependIndex
        ? `${String(i + 1).padStart(pad, "0")} - ${v.title}`
        : v.title;
      enqueueVideo(v.id, v.url, v.title, v.thumbnail ?? "", { ...params, title: fileTitle });
    }
  } else {
    enqueueVideo(
      pendingInfo.id,
      `https://www.youtube.com/watch?v=${pendingInfo.id}`,
      editedTitle,
      pendingInfo.thumbnail,
      params
    );
  }

  // Persist output path as new default
  if (outputPath !== config.defaultOutputPath) {
    config.defaultOutputPath = outputPath;
    invoke("set_config", { input: { defaultOutputPath: outputPath } }).catch(
      () => {}
    );
  }

  closePopover();
}

function enqueueVideo(
  id: string,
  url: string,
  title: string,
  thumbnail: string,
  params: DownloadParams
) {
  const itemId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  items.set(itemId, {
    id: itemId, url, title, thumbnail, params,
    status: "queued", percent: 0, speed: "",
  });
  renderItem(items.get(itemId)!);
  hide($("queue-empty"));

  downloadQueue.push({ id: itemId, url, params });
  saveQueue();
  updateQueueToolbar();
  drainQueue();
}

function drainQueue() {
  while (activeCount < MAX_CONCURRENT && downloadQueue.length > 0) {
    const job = downloadQueue.shift()!;
    activeCount++;
    invoke("start_download", { id: job.id, url: job.url, params: job.params })
      .catch((e: unknown) => {
        updateItem(job.id, { status: "error", speed: String(e) });
        onDownloadFinished();
      });
  }
}

function onDownloadFinished() {
  activeCount = Math.max(0, activeCount - 1);
  drainQueue();
}

// ── Queue persistence ─────────────────────────────────────────────────────────

const QUEUE_STORAGE_KEY = "ytdl-queue";

function saveQueue() {
  localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([...items.values()]));
}

async function loadQueue() {
  const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
  if (!raw) return;

  let saved: DownloadItem[];
  try {
    saved = JSON.parse(raw);
  } catch {
    return;
  }

  // Ask the backend which downloads are already running so we don't re-dispatch
  // them (handles frontend-only reload where the Tauri backend stays alive).
  const activeIds = new Set<string>(
    await invoke<string[]>("get_active_downloads").catch(() => [])
  );

  for (const item of saved) {
    if (item.status === "downloading") {
      if (activeIds.has(item.id)) {
        // Still running on backend — leave as downloading, don't re-queue
      } else {
        // Backend process died (full app restart) — re-queue
        item.status = "queued";
        item.percent = 0;
        item.speed = "";
      }
    }
    items.set(item.id, item);
    renderItem(item);
    if (item.status === "queued") {
      downloadQueue.push({ id: item.id, url: item.url, params: item.params });
    }
  }

  // Seed activeCount from backend so drainQueue doesn't over-dispatch
  activeCount = activeIds.size;

  updateQueueToolbar();
  drainQueue();
}

// ── Clear queue ───────────────────────────────────────────────────────────────

function updateQueueToolbar() {
  const toolbar = $("queue-toolbar");
  const countEl = $("queue-count");
  const emptyEl = $("queue-empty");

  if (items.size === 0) {
    hide(toolbar);
    show(emptyEl);
    return;
  }

  show(toolbar);
  hide(emptyEl);

  const vals = [...items.values()];
  const done = vals.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;
  const failed = vals.filter((i) => i.status === "error").length;
  countEl.textContent = `${items.size} item${items.size !== 1 ? "s" : ""}${done ? ` · ${done} completed` : ""}`;

  const retryBtn = $("retry-btn");
  if (failed > 0) {
    show(retryBtn);
    retryBtn.textContent = `Retry failed (${failed})`;
  } else {
    hide(retryBtn);
  }
}

function openClearMenu() {
  const menu = $("clear-menu");
  const hasCompleted = [...items.values()].some((i) =>
    ["done", "error", "cancelled"].includes(i.status)
  );
  $<HTMLButtonElement>("clear-completed-btn").disabled = !hasCompleted;
  menu.classList.toggle("hidden");
}

function closeClearMenu() {
  $("clear-menu").classList.add("hidden");
}

function clearCompleted() {
  for (const [id, item] of items) {
    if (["done", "error", "cancelled"].includes(item.status)) {
      items.delete(id);
      document.getElementById(`card-${id}`)?.remove();
    }
  }
  saveQueue();
  updateQueueToolbar();
  closeClearMenu();
}

function clearAll() {
  // Cancel any active backend downloads
  for (const [id, item] of items) {
    if (item.status === "downloading") {
      invoke("cancel_download", { id }).catch(() => {});
    }
  }
  // Drop frontend queue
  downloadQueue.length = 0;
  activeCount = 0;
  // Remove all cards
  items.clear();
  document.querySelectorAll<HTMLElement>(".queue-card").forEach((el) => el.remove());
  saveQueue();
  updateQueueToolbar();
  closeClearMenu();
}

function moveCardToBottom(id: string) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  $("queue").appendChild(card);
  card.classList.remove("card-requeued");
  void card.offsetWidth; // force reflow so animation restarts
  card.classList.add("card-requeued");
  card.addEventListener("animationend", () => card.classList.remove("card-requeued"), { once: true });
}

function retryFailed() {
  for (const item of items.values()) {
    if (item.status !== "error") continue;
    updateItem(item.id, { status: "queued", percent: 0, speed: "" });
    downloadQueue.push({ id: item.id, url: item.url, params: item.params });
    moveCardToBottom(item.id);
  }
  updateQueueToolbar();
  drainQueue();
}

function bindClearMenu() {
  $("retry-btn").addEventListener("click", retryFailed);
  $("clear-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openClearMenu();
  });
  $("clear-completed-btn").addEventListener("click", clearCompleted);
  $("clear-all-btn").addEventListener("click", clearAll);
  document.addEventListener("click", (e) => {
    if (!$("clear-wrap")?.contains(e.target as Node)) closeClearMenu();
  });
}

// ── Queue rendering ───────────────────────────────────────────────────────────

function renderItem(item: DownloadItem) {
  const queue = $("queue");
  const card = document.createElement("div");
  card.className = "queue-card";
  card.id = `card-${item.id}`;
  card.innerHTML = cardHTML(item);
  queue.appendChild(card);

  card.querySelector(".card-show-folder")?.addEventListener("click", () => {
    const current = items.get(item.id);
    if (!current) return;
    if (current.outputPath) {
      revealItemInDir(current.outputPath).catch(() => openPath(current.params.outputPath).catch(() => {}));
    } else {
      openPath(current.params.outputPath).catch(() => {});
    }
  });

  card.querySelector(".card-retry")?.addEventListener("click", () => {
    const current = items.get(item.id);
    if (!current || !["error", "cancelled"].includes(current.status)) return;
    updateItem(item.id, { status: "queued", percent: 0, speed: "" });
    downloadQueue.push({ id: item.id, url: item.url, params: current.params });
    moveCardToBottom(item.id);
    updateQueueToolbar();
    drainQueue();
  });

  card.querySelector(".card-cancel")?.addEventListener("click", () => {
    const current = items.get(item.id);
    if (current?.status === "queued") {
      // Remove from frontend queue without touching the backend
      const idx = downloadQueue.findIndex((j) => j.id === item.id);
      if (idx !== -1) downloadQueue.splice(idx, 1);
      updateItem(item.id, { status: "cancelled", speed: "" });
    } else {
      invoke("cancel_download", { id: item.id }).catch(() => {});
    }
  });
}

function cardHTML(item: DownloadItem): string {
  const thumbHTML = item.thumbnail
    ? `<img class="card-thumb" src="${escapeHtml(item.thumbnail)}" alt="" />`
    : `<div class="card-thumb card-thumb-placeholder"></div>`;

  return `
    ${thumbHTML}
    <div class="card-body">
      <div class="card-top">
        <span class="card-title">${escapeHtml(item.title)}</span>
        <span class="card-badge badge-${item.status}">${badgeLabel(item.status)}</span>
      </div>
      <div class="card-progress-wrap ${item.status === "queued" ? "hidden" : ""}">
        <div class="card-progress-bar">
          <div class="card-progress-fill" style="width:${item.percent}%"></div>
        </div>
        <span class="card-speed">${escapeHtml(item.speed)}</span>
      </div>
    </div>
    <div class="card-actions">
      <button class="card-show-folder ${item.status === "done" && item.outputPath ? "" : "hidden"}" title="Show in folder">&#x1F4C2;</button>
      <button class="card-retry ${["error", "cancelled"].includes(item.status) ? "" : "hidden"}" title="Retry">&#x21BA;</button>
      <button class="card-cancel ${["done", "error", "cancelled"].includes(item.status) ? "hidden" : ""}" title="Cancel">&#x2715;</button>
    </div>
  `;
}

function updateItem(id: string, patch: Partial<DownloadItem>) {
  const item = items.get(id);
  if (!item) return;
  Object.assign(item, patch);

  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  // Update badge
  const badge = card.querySelector<HTMLElement>(".card-badge");
  if (badge) {
    badge.className = `card-badge badge-${item.status}`;
    badge.textContent = badgeLabel(item.status);
  }

  // Update progress bar fill (percent < 0 = indeterminate)
  const bar = card.querySelector<HTMLElement>(".card-progress-bar");
  const fill = card.querySelector<HTMLElement>(".card-progress-fill");
  if (bar && fill) {
    if (item.percent < 0) {
      bar.classList.add("indeterminate");
      fill.style.width = "";
    } else {
      bar.classList.remove("indeterminate");
      fill.style.width = `${item.percent}%`;
    }
  }

  // Show/hide progress wrap
  const wrap = card.querySelector<HTMLElement>(".card-progress-wrap");
  if (wrap) {
    if (item.status === "queued") {
      wrap.classList.add("hidden");
    } else {
      wrap.classList.remove("hidden");
    }
  }

  // Update speed text
  const speed = card.querySelector<HTMLElement>(".card-speed");
  if (speed) speed.textContent = item.speed;

  // Show "show in folder" only when done and path is known
  const folderBtn = card.querySelector<HTMLButtonElement>(".card-show-folder");
  if (folderBtn) {
    folderBtn.classList.toggle("hidden", !(item.status === "done" && !!item.outputPath));
  }

  // Show retry button only for retryable terminal states
  const retryBtn = card.querySelector<HTMLButtonElement>(".card-retry");
  if (retryBtn) {
    retryBtn.classList.toggle("hidden", !["error", "cancelled"].includes(item.status));
  }

  // Hide cancel button when terminal state
  const cancelBtn = card.querySelector<HTMLButtonElement>(".card-cancel");
  if (cancelBtn) {
    const terminal = ["done", "error", "cancelled"].includes(item.status);
    cancelBtn.classList.toggle("hidden", terminal);
  }

  if (["done", "error", "cancelled"].includes(item.status)) {
    updateQueueToolbar();
  }

  saveQueue();
}

function badgeLabel(status: DownloadItem["status"]): string {
  return {
    queued: "QUEUED",
    downloading: "DOWNLOADING",
    done: "DONE",
    error: "ERROR",
    cancelled: "CANCELLED",
  }[status];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Tauri event listeners ─────────────────────────────────────────────────────

async function bindEvents() {
  await listen<StatusPayload>("download:started", ({ payload }) => {
    console.log("[dl] started", payload.id);
    updateItem(payload.id, { status: "downloading", percent: 0 });
  });

  await listen<ProgressPayload>("download:progress", ({ payload }) => {
    console.log("[dl] progress", payload.id, payload.percent, payload.speed);
    updateItem(payload.id, {
      status: "downloading",
      percent: payload.percent,
      speed: payload.speed,
    });
  });

  await listen<CompletePayload>("download:complete", ({ payload }) => {
    console.log("[dl] complete", payload.id, payload.outputPath);
    updateItem(payload.id, { status: "done", percent: 100, speed: "", outputPath: payload.outputPath });
    onDownloadFinished();
  });

  await listen<StatusPayload>("download:cancelled", ({ payload }) => {
    console.log("[dl] cancelled", payload.id);
    updateItem(payload.id, { status: "cancelled", speed: "" });
    onDownloadFinished();
  });

  await listen<ErrorPayload>("download:error", ({ payload }) => {
    console.log("[dl] error", payload.id, payload.message);
    updateItem(payload.id, { status: "error", speed: payload.message });
    onDownloadFinished();
  });
}

// ── Banner ────────────────────────────────────────────────────────────────────

function bindBanner() {
  $("banner-close").addEventListener("click", () => hide($("banner")));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  init().catch(console.error);
});
