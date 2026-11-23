//! Per-media-frame samples of the framing the compositor computes, for the Resolve export.
//!
//! The Resolve export does not bake the screen or the camera into a video: a Fusion effect redraws
//! them live from numbers. Those numbers are what `plan_frame` / `plan_cursor` give the GPU
//! backends for the same source time, so the effect and the app's own export agree. No GPU here:
//! the planners are pure.
//!
//! The setup mirrors `timeline_walk::walk_composited_timeline` and `compose_frame`: the scene is
//! narrowed to the clip with `Scene::for_clip_window`, `timeline_t_override` and `programme_time`
//! carry the source time, the texture is the visible frame (`u_max = v_max = 1`), and the cursor
//! track is the one the export loads (`CursorTrack::load` then `.smoothed(scene.cursor.smoothing)`).
//!
//! Layout of one sample (19 numbers, see the data contract of the plan):
//! `box(4) rest(4) crop(4) radius unit cursor_x cursor_y cursor_size cursor_alpha cursor_kind`.
//! Lengths are normalised by the output height (`radius`, `unit`, `cursor_size`), boxes and the
//! cursor centre by the output size (y down).

use crate::config::Cfg;
use crate::cursor::CursorTrack;
use crate::frame_geometry::{
    live_params_from_scene, plan_cursor, plan_frame, webcam_source_rect_zoomed, CursorPlanInput,
    FrameGeometryInput,
};
use crate::scene::Scene;

/// Numbers per sample.
pub const STRIDE: usize = 19;

/// What the sampled layer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Screen,
    Camera,
}

/// 1-based index of `cursor_type` in `kinds`; the index of `"arrow"` when it is not listed; 0 when
/// neither is (no atlas kind to draw).
fn cursor_kind(cursor_type: Option<&str>, kinds: &[String]) -> f32 {
    let find = |name: &str| kinds.iter().position(|k| k == name).map(|i| (i + 1) as f32);
    cursor_type.and_then(find).or_else(|| find("arrow")).unwrap_or(0.0)
}

/// One 19-number sample per entry of `source_times` (seconds of the clip's screen source, the
/// ruler `timeline_t_override` reads).
///
/// - `cfg` is the export config (`export_cfg_and_scene`), `scene` the whole scene: it is narrowed
///   to `clip_index` here, over that clip's own source window. An out-of-range index, or the
///   camera role without a camera size, is an error.
/// - `cursor` is the track as the export hands it to the compositor: loaded with offset 0 and
///   already smoothed. Both roles need it (the camera dodges the pointer); only the screen role
///   writes cursor fields. `None` gives a zero cursor and no dodge.
/// - `cursor_kinds` is the atlas order; the cursor kind is a 1-based index into it.
/// - `webcam_px` is the camera's visible frame; a zero size means the clip has no camera.
#[allow(clippy::too_many_arguments)]
pub fn sample_frames(
    scene: &Scene,
    cfg: &Cfg,
    cursor: Option<&CursorTrack>,
    cursor_kinds: &[String],
    clip_index: usize,
    role: Role,
    source_times: &[f64],
    render_px: [f32; 2],
    screen_px: [f32; 2],
    webcam_px: [f32; 2],
) -> Result<Vec<[f32; STRIDE]>, String> {
    let clip = scene
        .clips
        .get(clip_index)
        .ok_or_else(|| format!("clip index {clip_index} is out of range ({} clips)", scene.clips.len()))?;
    let has_webcam = webcam_px[0] > 0.0 && webcam_px[1] > 0.0;
    if role == Role::Camera && !has_webcam {
        return Err("the camera role needs a camera size (webcamW/webcamH > 0)".to_string());
    }
    if source_times.is_empty() {
        return Ok(Vec::new());
    }
    // The clip's own source window, as the export and the live preview narrow the scene.
    let clip_scene = scene.for_clip_window(clip_index, clip.source_start_sec, clip.source_end_sec);
    // `live` comes from the whole scene and the camera flag is set per clip, as the export does;
    // a clip without a camera plans against the screen's size, as the export's stand-in does.
    let mut live = live_params_from_scene(scene);
    live.has_webcam = has_webcam;
    // The Fuse draws the flat sprite: a modelled 3D arrow would come back as `Tilted` even on a
    // flat screen, with the plane's centre as its position.
    live.cursor_model3d = false;
    let webcam_px = if has_webcam { webcam_px } else { screen_px };

    let rh = render_px[1].max(1.0);
    Ok(source_times
        .iter()
        .map(|&t| {
            let t32 = t as f32;
            let input = FrameGeometryInput {
                render_px,
                screen_tex_px: screen_px,
                screen_visible_px: screen_px,
                webcam_visible_px: webcam_px,
                u_max: 1.0,
                v_max: 1.0,
                frame: t32 * crate::frame_geometry::FPS,
                cfg,
                live,
                scene: Some(&clip_scene),
                cursor,
                timeline_t_override: Some(t32),
                programme_time: Some(t32),
            };
            let g = plan_frame(&input);
            let mut s = [0.0f32; STRIDE];
            match role {
                Role::Screen => {
                    s[0..4].copy_from_slice(&g.s_dst);
                    s[4..8].copy_from_slice(&g.s_ann);
                    s[8..12].copy_from_slice(&g.cut);
                    s[12] = g.s_radius / rh;
                    s[13] = g.screen_unit_px / rh;
                    if let Some(track) = cursor {
                        let plan = plan_cursor(
                            &g,
                            &CursorPlanInput {
                                render_px,
                                u_max: 1.0,
                                v_max: 1.0,
                                cfg,
                                live,
                                scene: Some(&clip_scene),
                                track,
                                t: t32,
                            },
                        );
                        if let Some(plan) = plan.filter(|p| p.alpha > 0.0) {
                            // The true pointer position in the output frame, tilted or not.
                            let [x, y] = plan.placement.upright_center();
                            s[14] = x;
                            s[15] = y;
                            s[16] = plan.size_px / rh;
                            s[17] = plan.alpha;
                            s[18] = cursor_kind(plan.cursor_type.as_deref(), cursor_kinds);
                        }
                    }
                }
                Role::Camera => {
                    s[0..4].copy_from_slice(&g.w_dst);
                    s[4..8].copy_from_slice(&g.w_dst);
                    // The same crop `compose_frame` samples the camera with. The mirror is not
                    // applied here: the effect flips.
                    let crop = webcam_source_rect_zoomed(
                        webcam_px,
                        webcam_px,
                        g.webcam_crop,
                        g.w_px[0] / g.w_px[1].max(0.0001),
                        g.webcam_zoom,
                        g.webcam_focus,
                    );
                    s[8..12].copy_from_slice(&crop);
                    s[12] = g.w_radius / rh;
                    s[13] = g.frame_min_px / rh;
                }
            }
            s
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_geometry::CursorPlacement;

    const RENDER: [f32; 2] = [1170.0, 658.0];
    const SCREEN: [f32; 2] = [1920.0, 1080.0];
    const WEBCAM: [f32; 2] = [1280.0, 720.0];

    /// The zoomed golden scene of `frame_geometry`'s tests: PiP camera, crop, one zoom (x2) over
    /// 1 -> 5 s of clip 0, output 1170x658.
    const ZOOMED: &str = r##"{
        "clips":[{"screenPath":"/s.mp4","webcamPath":"/w.mp4","sourceStartSec":0,"sourceEndSec":10,"webcamOffsetSec":0,"hasAudio":true}],
        "layout":{"preset":"picture-in-picture","webcamSize":0.44,"webcamShape":"circle","webcamMirror":false,
                  "webcamPosition":{"cx":0.8577,"cy":0.8159},"webcamReactiveZoom":false},
        "effects":{"padding":0.51,"blur":false,"shadow":0.35,"roundnessFrac":0.0255,"motionBlur":0.35},
        "background":{"kind":"color","color":"#1e1e2e"},
        "zoomRegions":[{"clipIndex":0,"startSec":1.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}],
        "cursor":{"show":true,"size":7.76,"smoothing":0,"motionBlur":0.35,"clickBounce":1,"clipToBounds":false,"theme":"default"},
        "cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],
        "output":{"width":1170,"height":658,"fps":60}
    }"##;

    fn scene() -> Scene {
        Scene::from_json(ZOOMED).expect("zoomed golden scene")
    }

    fn cfg_for(scene: &Scene) -> Cfg {
        // What `export_cfg_and_scene` builds.
        let mut cfg = crate::config::all().pop().expect("a config");
        cfg.zoom = false;
        cfg.layout_anim = false;
        cfg.mblur_n = 1;
        cfg.bg_blur = scene.effects.blur;
        cfg.cursor = scene.cursor.show;
        cfg
    }

    /// `plan_frame` the way the export calls it for a clip-narrowed scene.
    fn plan_at(
        scene: &Scene,
        cfg: &Cfg,
        track: Option<&CursorTrack>,
        t: f64,
    ) -> crate::frame_geometry::FrameGeometry {
        let clip = &scene.for_clip_window(0, 0.0, 10.0);
        plan_frame(&FrameGeometryInput {
            render_px: RENDER,
            screen_tex_px: SCREEN,
            screen_visible_px: SCREEN,
            webcam_visible_px: WEBCAM,
            u_max: 1.0,
            v_max: 1.0,
            frame: 0.0,
            cfg,
            live: {
                let mut l = live_params_from_scene(scene);
                l.has_webcam = true;
                l
            },
            scene: Some(clip),
            cursor: track,
            timeline_t_override: Some(t as f32),
            programme_time: Some(t as f32),
        })
    }

    #[test]
    fn samples_match_plan_frame() {
        let scene = scene();
        let cfg = cfg_for(&scene);
        let times = [0.0, 2.5, 6.0];
        let got = sample_frames(
            &scene, &cfg, None, &[], 0, Role::Screen, &times, RENDER, SCREEN, WEBCAM,
        ).unwrap();
        assert_eq!(got.len(), 3);
        for (s, &t) in got.iter().zip(&times) {
            let g = plan_at(&scene, &cfg, None, t);
            assert_eq!(s[0..4], g.s_dst, "box at {t}");
            assert_eq!(s[4..8], g.s_ann, "rest box at {t}");
            assert_eq!(s[8..12], g.cut, "crop at {t}");
            assert_eq!(s[12], g.s_radius / RENDER[1]);
            assert_eq!(s[13], g.screen_unit_px / RENDER[1]);
            assert_eq!(s[14..19], [0.0; 5], "no cursor track");
        }
        // Past the zoom the box is back on its resting box; inside it the box is larger.
        assert_eq!(got[2][0..4], got[2][4..8], "t = 6.0 is past the zoom");
        assert!(got[1][2] > got[1][6] * 1.5, "t = 2.5 is zoomed: {:?} vs {:?}", &got[1][0..4], &got[1][4..8]);
        assert!(got[1][3] > got[1][7] * 1.5);
        assert_eq!(got[0][0..4], got[0][4..8], "t = 0 is before the zoom");
    }

    #[test]
    fn camera_role_reads_webcam_box() {
        let scene = scene();
        let cfg = cfg_for(&scene);
        let times = [0.0, 2.5, 6.0];
        let got = sample_frames(
            &scene, &cfg, None, &[], 0, Role::Camera, &times, RENDER, SCREEN, WEBCAM,
        ).unwrap();
        for (s, &t) in got.iter().zip(&times) {
            let g = plan_at(&scene, &cfg, None, t);
            assert_eq!(s[0..4], g.w_dst, "camera box at {t}");
            assert_eq!(s[4..8], g.w_dst, "rest = box at {t}");
            let crop = webcam_source_rect_zoomed(
                WEBCAM,
                WEBCAM,
                g.webcam_crop,
                g.w_px[0] / g.w_px[1].max(0.0001),
                g.webcam_zoom,
                g.webcam_focus,
            );
            assert_eq!(s[8..12], crop, "camera crop at {t}");
            assert_eq!(s[12], g.w_radius / RENDER[1]);
            assert_eq!(s[13], g.frame_min_px / RENDER[1]);
            assert_eq!(s[14..19], [0.0; 5], "the camera has no cursor");
            assert!(s[2] > 0.0 && s[3] > 0.0, "the PiP has a size at {t}");
        }
    }

    /// A camera zoom reaches the Resolve samples through the camera's crop: at 2x the cut is half
    /// as wide and half as tall as without, centred on the zoom's focus, the camera's box keeps its
    /// size, and the screen's samples do not move.
    #[test]
    fn a_camera_zoom_closes_the_camera_cut_in_on_its_focus() {
        let with = Scene::from_json(&ZOOMED.replace(
            r#""zoomRegions":"#,
            r#""cameraZoomRegions":[{"clipIndex":0,"startSec":1.0,"endSec":5.0,"scale":2.0,"focusX":0.4,"focusY":0.45,"rotation":null}],"zoomRegions":"#,
        ))
        .expect("scene with a camera zoom");
        let without = scene();
        let cfg = cfg_for(&without);
        let sample = |s: &Scene, role: Role| {
            sample_frames(s, &cfg, None, &[], 0, role, &[3.0], RENDER, SCREEN, WEBCAM).unwrap()[0]
        };
        let (a, b) = (sample(&with, Role::Camera), sample(&without, Role::Camera));
        let (aw, ah, bw, bh) = (a[10] - a[8], a[11] - a[9], b[10] - b[8], b[11] - b[9]);
        assert!((aw / bw - 0.5).abs() < 1e-4 && (ah / bh - 0.5).abs() < 1e-4, "half at 2x: {a:?} vs {b:?}");
        assert!(((a[8] + a[10]) / 2.0 - 0.4).abs() < 1e-4, "centred on the focus across: {a:?}");
        assert!(((a[9] + a[11]) / 2.0 - 0.45).abs() < 1e-4, "centred on the focus down: {a:?}");
        assert_eq!(a[0..8], b[0..8], "the camera's box keeps its size");
        assert_eq!(sample(&with, Role::Screen), sample(&without, Role::Screen), "the screen does not move");
    }

    #[test]
    fn cursor_kind_is_one_based_with_an_arrow_fallback() {
        let kinds: Vec<String> = ["pointer", "arrow", "text"].iter().map(|s| s.to_string()).collect();
        assert_eq!(cursor_kind(Some("text"), &kinds), 3.0);
        assert_eq!(cursor_kind(Some("pointer"), &kinds), 1.0);
        assert_eq!(cursor_kind(Some("grab"), &kinds), 2.0, "unknown type -> arrow");
        assert_eq!(cursor_kind(None, &kinds), 2.0);
        assert_eq!(cursor_kind(Some("grab"), &[]), 0.0);
    }

    /// A real recording's cursor track (first 200 samples, sprite images stripped).
    #[test]
    fn cursor_matches_plan_cursor_on_a_real_track() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/resolve-cursor-sample.cursor.json");
        let raw = CursorTrack::load(path, 0.0, 24.0 * 3600.0).expect("fixture track");
        // Plain framing (no crop, no zoom): the pointer stays inside the frame.
        let plain = ZOOMED
            .replace(r#""cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],"#, "")
            .replace(
                r#""zoomRegions":[{"clipIndex":0,"startSec":1.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}]"#,
                r#""zoomRegions":[]"#,
            );
        assert_ne!(plain, ZOOMED);
        let scene = Scene::from_json(&plain).expect("plain scene");
        let cfg = cfg_for(&scene);
        let track = raw.smoothed(scene.cursor.smoothing);
        let kinds: Vec<String> = ["arrow", "pointer", "text"].iter().map(|s| s.to_string()).collect();
        let times = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5];
        let got = sample_frames(
            &scene, &cfg, Some(&track), &kinds, 0, Role::Screen, &times, RENDER, SCREEN, WEBCAM,
        ).unwrap();
        let mut seen: Vec<(f32, f32)> = Vec::new();
        for (s, &t) in got.iter().zip(&times) {
            let g = plan_at(&scene, &cfg, Some(&track), t);
            let clip = scene.for_clip_window(0, 0.0, 10.0);
            let plan = plan_cursor(
                &g,
                &CursorPlanInput {
                    render_px: RENDER,
                    u_max: 1.0,
                    v_max: 1.0,
                    cfg: &cfg,
                    live: {
                        let mut l = live_params_from_scene(&scene);
                        l.has_webcam = true;
                        l
                    },
                    scene: Some(&clip),
                    track: &track,
                    t: t as f32,
                },
            );
            let Some(plan) = plan else {
                // Pointer outside the zoomed crop: nothing to draw, so the sample is zero.
                assert_eq!(s[14..19], [0.0; 5], "no plan -> zero cursor at {t}");
                continue;
            };
            let CursorPlacement::Upright { center } = plan.placement else {
                panic!("the golden scene is not tilted");
            };
            if plan.alpha <= 0.0 {
                assert_eq!(s[14..19], [0.0; 5], "hidden cursor -> zero at {t}");
                continue;
            }
            assert_eq!(s[14], center[0], "cursor x at {t}");
            assert_eq!(s[15], center[1], "cursor y at {t}");
            assert_eq!(s[16], plan.size_px / RENDER[1], "cursor size at {t}");
            assert_eq!(s[17], plan.alpha, "cursor alpha at {t}");
            assert!(s[18] >= 1.0 && s[18] <= 3.0, "kind {} at {t}", s[18]);
            seen.push((s[14], s[15]));
        }
        assert!(seen.len() >= 2, "the cursor is drawn at two times at least: {seen:?}");
        assert!(seen.windows(2).any(|w| w[0] != w[1]), "the cursor moves: {seen:?}");
    }

    /// PiP scene with a dodge slot (top-left), no crop, no zoom.
    fn dodge_scene() -> Scene {
        let json = ZOOMED
            .replace(r#""cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],"#, "")
            .replace(
                r#""zoomRegions":[{"clipIndex":0,"startSec":1.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}]"#,
                r#""zoomRegions":[]"#,
            )
            .replace(
                r#""webcamReactiveZoom":false}"#,
                r#""webcamReactiveZoom":false,"webcamDodgeRect":{"x":0.02,"y":0.02,"width":0.1,"height":0.18}}"#,
            );
        assert!(json.contains("webcamDodgeRect"));
        Scene::from_json(&json).expect("dodge scene")
    }

    /// A cursor file whose pointer rests at (cx, cy) of the screen for 4 s.
    fn still_track(name: &str, cx: f32, cy: f32) -> CursorTrack {
        let samples: Vec<String> = (0..40)
            .map(|i| {
                format!(
                    r#"{{"timeMs":{},"cx":{cx},"cy":{cy},"visible":true,"interactionType":"move"}}"#,
                    i * 100
                )
            })
            .collect();
        let path = std::env::temp_dir()
            .join(format!("resolve-samples-{name}-{}.cursor.json", std::process::id()));
        std::fs::write(
            &path,
            format!(
                r#"{{"version":2,"provider":"native","samples":[{}],"assets":[]}}"#,
                samples.join(",")
            ),
        )
        .unwrap();
        let track = CursorTrack::load(path.to_str().unwrap(), 0.0, 3600.0).expect("track");
        let _ = std::fs::remove_file(&path);
        track
    }

    /// With the modelled 3D cursor on, the sampled position still follows the pointer (not the
    /// plane's centre): the effect draws the flat sprite.
    #[test]
    fn model3d_cursor_follows_the_pointer() {
        let json = ZOOMED
            .replace(r#""cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],"#, "")
            .replace(
                r#""zoomRegions":[{"clipIndex":0,"startSec":1.0,"endSec":5.0,"scale":2.0,"focusX":0.5,"focusY":0.3,"rotation":"none"}]"#,
                r#""zoomRegions":[]"#,
            )
            .replace(r#""clipToBounds":false"#, r#""clipToBounds":false,"model3d":true"#);
        let scene = Scene::from_json(&json).expect("3d cursor scene");
        assert!(scene.cursor.model3d, "the scene asks for the 3D cursor");
        let cfg = cfg_for(&scene);
        let kinds: Vec<String> = ["arrow"].iter().map(|s| s.to_string()).collect();
        let at = |t: f64, cx: f32, cy: f32, name: &str| {
            let track = still_track(name, cx, cy);
            sample_frames(&scene, &cfg, Some(&track), &kinds, 0, Role::Screen, &[t], RENDER, SCREEN, WEBCAM)
                .unwrap()[0]
        };
        let a = at(1.0, 0.25, 0.25, "m3d-a");
        let b = at(2.0, 0.75, 0.75, "m3d-b");
        assert!(a[17] > 0.0 && b[17] > 0.0, "the cursor is drawn: {a:?} {b:?}");
        assert!(b[14] > a[14] + 0.1, "x follows the pointer: {} -> {}", a[14], b[14]);
        assert!(b[15] > a[15] + 0.1, "y follows the pointer: {} -> {}", a[15], b[15]);
    }

    #[test]
    fn camera_dodges_the_pointer_when_it_gets_the_track() {
        let scene = dodge_scene();
        let cfg = cfg_for(&scene);
        let times = [1.5];
        let sample = |track: Option<&CursorTrack>, role| {
            sample_frames(&scene, &cfg, track, &[], 0, role, &times, RENDER, SCREEN, WEBCAM)
                .unwrap()[0]
        };
        let rest = sample(None, Role::Camera);
        let screen = sample(None, Role::Screen);
        // The PiP sits just outside the screen box, so the pointer goes to the screen's
        // bottom-right corner: inside the camera's zone plus its dodge margin (0.03), in the
        // output frame, worked out here from the two sampled boxes.
        let (px, py) = (0.995f32, 0.995f32);
        let (ox, oy) = (screen[0] + px * screen[2], screen[1] + py * screen[3]);
        assert!(ox > rest[0] - 0.03 && oy > rest[1] - 0.03, "the pointer is next to the camera");
        let on_camera = still_track("on", px, py);
        let far = still_track("far", 0.05, 0.05);

        let dodged = sample(Some(&on_camera), Role::Camera);
        let expected = [0.02, 0.02, 0.1, 0.18]; // the scene's webcamDodgeRect, as authored
        for i in 0..4 {
            assert!(
                (dodged[i] - expected[i]).abs() < 1e-4,
                "box {:?} should sit in the dodge slot",
                &dodged[0..4]
            );
        }
        assert_eq!(dodged[4..8], dodged[0..4], "rest = box for the camera");
        assert_eq!(sample(Some(&far), Role::Camera)[0..4], rest[0..4], "a far pointer leaves it");
        assert_eq!(sample(None, Role::Camera)[0..4], rest[0..4], "no track, no dodge");
    }

    #[test]
    fn a_region_without_a_clip_index_ramps_in_over_the_clip_window() {
        let json = ZOOMED
            .replace(r#""cropByClip":[{"x":0,"y":0,"width":0.61,"height":0.61}],"#, "")
            .replace(r#""clipIndex":0,"startSec":1.0,"endSec":5.0"#, r#""startSec":5.0,"endSec":8.0"#);
        assert_ne!(json, ZOOMED);
        let scene = Scene::from_json(&json).expect("legacy region scene");
        let cfg = cfg_for(&scene);
        // Just before the region starts: the sub-span [4.8, 4.9] does not overlap [5, 8].
        let times = [4.8, 4.9];
        let got =
            sample_frames(&scene, &cfg, None, &[], 0, Role::Screen, &times, RENDER, SCREEN, WEBCAM)
                .unwrap();
        for (s, &t) in got.iter().zip(&times) {
            let g = plan_at(&scene, &cfg, None, t); // full clip window 0..10
            assert_eq!(s[0..4], g.s_dst, "box at {t}");
        }
        assert!(got[1][2] > got[1][6], "the zoom already eases in at 4.9: {:?}", &got[1][0..8]);
    }

    #[test]
    fn bad_inputs_are_errors() {
        let scene = scene();
        let cfg = cfg_for(&scene);
        let run = |clip, role, webcam| {
            sample_frames(&scene, &cfg, None, &[], clip, role, &[1.0], RENDER, SCREEN, webcam)
        };
        assert!(run(1, Role::Screen, WEBCAM).is_err(), "clip index out of range");
        assert!(run(0, Role::Camera, [0.0, 0.0]).is_err(), "camera role without a camera");
        assert!(run(0, Role::Screen, [0.0, 0.0]).is_ok(), "a screen sample needs no camera");
    }
}
