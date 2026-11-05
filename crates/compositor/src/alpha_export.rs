//! Export of a scene's overlay layer as a video with a real alpha channel.
//!
//! The scene is flagged `overlayOnly` (see `Scene::overlay_only`): the compositor then draws
//! nothing but the annotations (keycaps, picture-in-picture, text, arrows) on a transparent
//! frame. This module walks the timeline exactly as the GIF and MP4 exporters do (same clips,
//! same speed segments, same trims), reads each composed frame back and hands it to an
//! `ffmpeg` process that writes ProRes 4444, the codec an editor takes with alpha.
//!
//! The compositor's output is premultiplied; ProRes keeps straight alpha, so each frame is
//! unpremultiplied here before it is written.

use crate::compositor::Compositor;
use crate::config::Cfg;
use crate::d3d::Gpu;
use crate::export_control::{with_staged_output, ExportControl};
use crate::pipeline::{ClipSource, Decoder};
use crate::timeline_walk::walk_composited_timeline;
use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

pub struct AlphaExportParams {
	pub width: u32,
	pub height: u32,
	pub fps: u32,
	/// The `ffmpeg` executable the app ships; the encoder runs in a child process.
	pub ffmpeg_path: String,
}

pub struct AlphaStats {
	pub frames: u64,
	pub wall_s: f64,
	pub fps: f64,
	pub video_duration_s: f64,
	pub file_bytes: u64,
}

/// Premultiplied RGBA to straight RGBA, in place. Fully transparent pixels become black.
pub fn unpremultiply(rgba: &mut [u8]) {
	for px in rgba.chunks_exact_mut(4) {
		let a = px[3] as u32;
		match a {
			0 => px[..3].fill(0),
			255 => {}
			_ => {
				for c in &mut px[..3] {
					*c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
				}
			}
		}
	}
}

/// The arguments that make `ffmpeg` read raw RGBA frames on stdin and write ProRes 4444.
fn ffmpeg_args(params: &AlphaExportParams, output: &Path) -> Vec<String> {
	[
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgba",
		"-s",
		&format!("{}x{}", params.width, params.height),
		"-framerate",
		&params.fps.to_string(),
		"-i",
		"-",
		"-c:v",
		"prores_ks",
		"-profile:v",
		"4444",
		"-pix_fmt",
		"yuva444p10le",
		"-vendor",
		"apl0",
		&output.to_string_lossy(),
	]
	.iter()
	.map(|s| s.to_string())
	.collect()
}

pub fn export_alpha_video_cancellable(
	clips: &[ClipSource],
	out_path: &Path,
	gpu: &Gpu,
	comp: &Compositor,
	cfg: &Cfg,
	params: &AlphaExportParams,
	progress: &mut dyn FnMut(u64),
	control: &ExportControl,
) -> Result<AlphaStats> {
	with_staged_output(out_path, control, |file, staging_path| {
		// ffmpeg reopens the staged path itself.
		drop(file);
		export_alpha_inner(clips, staging_path, gpu, comp, cfg, params, progress, control)
	})
}

fn export_alpha_inner(
	clips: &[ClipSource],
	out_path: &Path,
	gpu: &Gpu,
	comp: &Compositor,
	cfg: &Cfg,
	params: &AlphaExportParams,
	progress: &mut dyn FnMut(u64),
	control: &ExportControl,
) -> Result<AlphaStats> {
	control.check()?;
	if clips.is_empty() {
		bail!("export_alpha_video: no clip to export");
	}
	let fps = params.fps.max(1);
	let t0 = Instant::now();
	let scene = comp.scene_snapshot();

	let mut child = Command::new(&params.ffmpeg_path)
		.args(ffmpeg_args(params, out_path))
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.with_context(|| format!("starting ffmpeg at {}", params.ffmpeg_path))?;
	let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("ffmpeg has no stdin"))?;

	let mut screen_decs: HashMap<String, Decoder> = HashMap::new();
	let mut webcam_decs: HashMap<String, Decoder> = HashMap::new();
	screen_decs.insert(clips[0].screen.clone(), unsafe {
		Decoder::open_for_export(&clips[0].screen, gpu)?
	});

	let walked = unsafe {
		walk_composited_timeline(
			clips,
			gpu,
			comp,
			cfg,
			fps as i32,
			&scene,
			&mut screen_decs,
			&mut webcam_decs,
			&mut |frame_index| {
				control.check()?;
				let (rw, rh, mut rgba) = comp
					.readback_direct()
					.map_err(|e| anyhow!("export_alpha_video: readback @ frame {frame_index}: {e:#}"))?;
				if rw != params.width || rh != params.height {
					bail!("export_alpha_video: frame is {rw}x{rh}, expected {}x{}", params.width, params.height);
				}
				unpremultiply(&mut rgba);
				stdin
					.write_all(&rgba)
					.map_err(|e| anyhow!("export_alpha_video: ffmpeg stopped reading: {e}"))?;
				progress(frame_index + 1);
				Ok(())
			},
			// No audio track: nothing to do at clip boundaries.
			&mut |_, _, _, _| control.check(),
		)
	};
	drop(stdin);
	let output = child.wait_with_output().context("waiting for ffmpeg")?;
	let frames = walked?;
	if !output.status.success() {
		bail!(
			"ffmpeg failed ({}): {}",
			output.status,
			String::from_utf8_lossy(&output.stderr).trim()
		);
	}
	control.check()?;
	let wall_s = t0.elapsed().as_secs_f64();
	let file_bytes = std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
	Ok(AlphaStats {
		frames,
		wall_s,
		fps: if wall_s > 0.0 { frames as f64 / wall_s } else { 0.0 },
		video_duration_s: frames as f64 / fps as f64,
		file_bytes,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unpremultiply_restores_straight_colour() {
		let mut px = vec![
			255, 0, 0, 255, // opaque: untouched
			127, 127, 127, 127, // half-covered white
			0, 0, 0, 0, // nothing
			10, 20, 30, 0, // garbage under no coverage
		];
		unpremultiply(&mut px);
		assert_eq!(&px[0..4], &[255, 0, 0, 255]);
		assert_eq!(&px[4..8], &[255, 255, 255, 127]);
		assert_eq!(&px[8..12], &[0, 0, 0, 0]);
		assert_eq!(&px[12..16], &[0, 0, 0, 0]);
	}

	#[test]
	fn the_command_reads_raw_rgba_and_writes_prores_4444() {
		let params = AlphaExportParams { width: 1080, height: 1920, fps: 30, ffmpeg_path: "ffmpeg".into() };
		let args = ffmpeg_args(&params, Path::new("/tmp/out.mov"));
		let joined = args.join(" ");
		assert!(joined.contains("-f rawvideo -pix_fmt rgba -s 1080x1920 -framerate 30 -i -"));
		assert!(joined.contains("-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le"));
		assert!(joined.ends_with("/tmp/out.mov"));
	}
}
