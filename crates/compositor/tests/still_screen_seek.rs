//! A screen recording has a frame only when the screen changes: on a still screen ScreenCaptureKit
//! writes about one a second (measured: 3.055, 4.055, 5.055 s in a real take). A seek that took the
//! first frame AT OR AFTER its target landed up to a second in the future on such a screen, and the
//! preview's clock jumped with it: the camera, the cursor and the zoom ran a second ahead until the
//! drift watch pulled them back, once or twice. That was the picture going "back and forth" after a
//! click on the timeline. The frame on screen at a moment is the last one shown before it.
//!
//! Needs a GPU (VideoToolbox), so it runs on a Mac:
//!
//! ```sh
//! cargo test -p openscreen-compositor --test still_screen_seek -- --nocapture
//! ```

#![cfg(target_os = "macos")]

use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::Decoder;

/// One frame a second, at 0..=5 s, only the first a keyframe.
fn fixture() -> String {
    format!("{}/tests/fixtures/still-screen-1fps.mp4", env!("CARGO_MANIFEST_DIR"))
}

unsafe fn seek(decoder: &mut Decoder, seconds: f64) -> f64 {
    let frame = decoder.seek_to(seconds).expect("seek");
    assert!(!frame.is_null(), "a frame at {seconds} s");
    decoder.cur_time_sec()
}

#[test]
fn a_seek_into_a_still_stretch_holds_the_frame_on_screen() {
    let gpu = Gpu::create(false).expect("device");
    let mut decoder = Decoder::open(&fixture(), &gpu).expect("open the fixture");
    unsafe {
        // Full keyframe seek, then forward from a held frame (the fast path).
        assert_eq!(seek(&mut decoder, 4.3), 4.0, "the frame shown at 4.3 s is the one from 4 s");
        assert_eq!(seek(&mut decoder, 4.6), 4.0, "still the 4 s frame: the next is at 5 s");
        // A frame at the target, or just after it, is still taken as the frame for it.
        assert_eq!(seek(&mut decoder, 2.0), 2.0);
        assert_eq!(seek(&mut decoder, 1.95), 2.0);
        // Backwards, as a click behind the playhead does.
        assert_eq!(seek(&mut decoder, 1.4), 1.0);
        assert_eq!(seek(&mut decoder, 0.2), 0.0);
    }
}

#[test]
fn the_next_frame_comes_in_its_turn_after_a_held_one() {
    let gpu = Gpu::create(false).expect("device");
    let mut decoder = Decoder::open(&fixture(), &gpu).expect("open the fixture");
    unsafe {
        assert_eq!(seek(&mut decoder, 3.5), 3.0);
        let next = decoder.next().expect("next");
        assert!(!next.is_null());
        assert_eq!(decoder.cur_time_sec(), 4.0, "the frame looked at and not taken is the next one");
    }
}
