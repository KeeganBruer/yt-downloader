use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn check_ffmpeg() -> bool {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}
