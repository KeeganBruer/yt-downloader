export interface VideoInfoResponse {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  resolutions: string[];
  isPlaylist: boolean;
  playlistCount?: number;
  videos?: PlaylistVideoResponse[];
}

export interface PlaylistVideoResponse {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
}

export interface DownloadParams {
  title: string;
  resolution: string;
  outputType: "video" | "audio";
  container: "mp4" | "mkv";
  audioFormat: "mp3" | "m4a";
  outputPath: string;
}

export interface DownloadItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  status: "queued" | "downloading" | "done" | "error" | "cancelled";
  percent: number;
  speed: string;
  params: DownloadParams;
  outputPath?: string;
}

export interface ConfigResponse {
  defaultOutputPath: string;
  ffmpegAvailable: boolean;
}

export interface ProgressPayload {
  id: string;
  percent: number;
  speed: string;
}

export interface StatusPayload {
  id: string;
}

export interface CompletePayload {
  id: string;
  outputPath?: string;
}

export interface ErrorPayload {
  id: string;
  message: string;
}
