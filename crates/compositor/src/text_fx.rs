//! What CoreText cannot draw: light, gradients that run through the letters, plasma, a glint.
//!
//! Everything here works on masks, one byte of coverage per pixel, and writes into a BGRA buffer
//! with premultiplied alpha, the form the compositor blends with `One, OneMinusSourceAlpha`. That
//! blend is why bloom can be real light: colour with little alpha adds to the picture behind it
//! instead of covering it, so a halo brightens the shirt rather than smearing grey over it.
//!
//! No clock and no randomness: every pixel is a function of the mask and of the time passed in, so
//! the same frame always exports the same.

/// A straight ramp of colours, or several: each line of text takes the next one.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FillSpec {
    /// "gradient", "plasma" or "none" (hollow letters: only the outline and the light).
    pub kind: String,
    pub palettes: Vec<Vec<[f32; 3]>>,
    /// Degrees. 90 runs top to bottom, 0 left to right.
    pub angle: f32,
    /// Trips through the ramp per second. 0 holds still.
    pub flow: f32,
    /// How big one wave of plasma is, in font sizes.
    pub scale: f32,
    /// The inside of a stroke burns towards white, as lit glass does. 0 to 1.
    pub core: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlowSpec {
    /// One per line, repeating.
    pub colors: Vec<[f32; 3]>,
    /// How far the light reaches, in font sizes.
    pub em: f32,
    pub strength: f32,
    /// How dark the pool behind the light is. 0 to 1.
    pub night: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShineSpec {
    pub color: [f32; 3],
    pub period_ms: f32,
    pub sweep_ms: f32,
    /// Width of the band, in font sizes.
    pub em: f32,
    pub angle: f32,
    pub strength: f32,
}

/// What a text's letters do beyond colour. All optional: absent is plain text.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextFx {
    pub fill: Option<FillSpec>,
    pub glow: Option<GlowSpec>,
    pub shine: Option<ShineSpec>,
    /// A shadow with a hard edge, and how far it extrudes: colour, x and y in font sizes.
    pub hard_shadow: Option<([f32; 4], f32, f32)>,
    /// Light from the top left across the letters' edges. 0 to 1.
    pub bevel: f32,
    /// Letter spacing, in font sizes.
    pub tracking_em: f32,
    /// A rounded box behind each line: colour, corner, padding across and down, in font sizes.
    pub line_plate: Option<([f32; 4], f32, f32, f32)>,
    /// All the lines in one box instead of one box each.
    pub plate_block: bool,
    /// Line spacing as a multiple of the font's own. 0: the font's own.
    pub leading: f32,
    /// How the whole block arrives: "blur" or "wipe".
    pub enter: Option<String>,
}

pub const ENTER_MS: f32 = 360.0;

impl TextFx {
    /// Whether these pixels change while the text holds still.
    pub fn moves(&self) -> bool {
        self.shine.is_some()
            || self
                .fill
                .as_ref()
                .is_some_and(|fill| fill.kind == "plasma" || fill.flow != 0.0)
    }
}

/// The word's size at this moment: up to `peak` fast, then back to `hold`.
pub fn pop_scale(elapsed_ms: f32, peak: f32, hold: f32) -> f32 {
    const RISE: f32 = 80.0;
    const FALL: f32 = 140.0;
    let ease = |t: f32| {
        let t = t.clamp(0.0, 1.0);
        1.0 - (1.0 - t) * (1.0 - t)
    };
    if elapsed_ms < RISE {
        1.0 + (peak - 1.0) * ease(elapsed_ms / RISE)
    } else {
        peak + (hold - peak) * ease((elapsed_ms - RISE) / FALL)
    }
}

pub const POP_WINDOW_MS: f32 = 220.0;
pub const SLIDE_MS: f32 = 110.0;

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn ramp(colors: &[[f32; 3]], p: f32) -> [f32; 3] {
    match colors {
        [] => [1.0, 1.0, 1.0],
        [only] => *only,
        _ => {
            let at = p.clamp(0.0, 1.0) * (colors.len() - 1) as f32;
            let i = (at as usize).min(colors.len() - 2);
            let k = at - i as f32;
            let (a, b) = (colors[i], colors[i + 1]);
            [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
        }
    }
}

/// Three passes of a box are close enough to a Gaussian, and cost the same at any radius.
fn box_pass(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let norm = 1.0 / (2 * r + 1) as f32;
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut sum = row[0] * (r + 1) as f32;
        for x in 1..=r {
            sum += row[x.min(w - 1)];
        }
        // Written transposed: the next pass runs along what was the other axis.
        for x in 0..w {
            dst[x * h + y] = sum * norm;
            sum += row[(x + r + 1).min(w - 1)] - row[x.saturating_sub(r)];
        }
    }
}

fn blur_small(src: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    if radius < 0.5 {
        return src.to_vec();
    }
    let r = (radius * 0.58).round().max(1.0) as usize;
    let mut a = src.to_vec();
    let mut b = vec![0.0; w * h];
    // Six transposes: the picture comes out the way it went in.
    for pass in 0..6 {
        let (pw, ph) = if pass % 2 == 0 { (w, h) } else { (h, w) };
        box_pass(&a, &mut b, pw, ph, r);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

/// A blur of any size at about the cost of a small one: wide light has no detail to lose.
pub fn blur(src: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    let down = ((radius / 6.0) as usize).clamp(1, 8);
    if down == 1 {
        return blur_small(src, w, h, radius);
    }
    let (sw, sh) = (w.div_ceil(down), h.div_ceil(down));
    let mut small = vec![0.0; sw * sh];
    for y in 0..h {
        for x in 0..w {
            small[(y / down) * sw + x / down] += src[y * w + x];
        }
    }
    let norm = 1.0 / (down * down) as f32;
    small.iter_mut().for_each(|v| *v *= norm);
    let small = blur_small(&small, sw, sh, radius / down as f32);
    let mut out = vec![0.0; w * h];
    let scale = 1.0 / down as f32;
    for y in 0..h {
        let fy = (y as f32 + 0.5) * scale - 0.5;
        let y0 = (fy.floor().max(0.0) as usize).min(sh - 1);
        let y1 = (y0 + 1).min(sh - 1);
        let ky = (fy - y0 as f32).clamp(0.0, 1.0);
        for x in 0..w {
            let fx = (x as f32 + 0.5) * scale - 0.5;
            let x0 = (fx.floor().max(0.0) as usize).min(sw - 1);
            let x1 = (x0 + 1).min(sw - 1);
            let kx = (fx - x0 as f32).clamp(0.0, 1.0);
            let top = small[y0 * sw + x0] * (1.0 - kx) + small[y0 * sw + x1] * kx;
            let bottom = small[y1 * sw + x0] * (1.0 - kx) + small[y1 * sw + x1] * kx;
            out[y * w + x] = top * (1.0 - ky) + bottom * ky;
        }
    }
    out
}

pub fn to_float(mask: &[u8]) -> Vec<f32> {
    mask.iter().map(|&v| v as f32 / 255.0).collect()
}

/// Light added to the picture. `body` is how much of the picture behind it the light replaces:
/// none at all and a bright shirt washes the colour out to white.
pub fn add_light(out: &mut [u8], light: &[f32], color: [f32; 3], body: f32) {
    for (i, (px, &l)) in out.chunks_exact_mut(4).zip(light).enumerate() {
        if l <= 0.002 {
            continue;
        }
        // A step of dither: wide light over a dark shirt bands otherwise, and the encoder keeps it.
        let dither = if (i ^ (i >> 3)) & 1 == 0 { 0.0 } else { 0.5 };
        let l = l.min(1.0);
        px[0] = (px[0] as f32 + color[2] * l * 255.0 + dither).min(255.0) as u8;
        px[1] = (px[1] as f32 + color[1] * l * 255.0 + dither).min(255.0) as u8;
        px[2] = (px[2] as f32 + color[0] * l * 255.0 + dither).min(255.0) as u8;
        px[3] = (px[3] as f32 + (255.0 - px[3] as f32) * l * body).min(255.0) as u8;
    }
}

fn blend(px: &mut [u8], rgb: [f32; 3], a: f32) {
    let keep = 1.0 - a;
    px[0] = (rgb[2].clamp(0.0, 1.0) * a * 255.0 + px[0] as f32 * keep) as u8;
    px[1] = (rgb[1].clamp(0.0, 1.0) * a * 255.0 + px[1] as f32 * keep) as u8;
    px[2] = (rgb[0].clamp(0.0, 1.0) * a * 255.0 + px[2] as f32 * keep) as u8;
    px[3] = (a * 255.0 + px[3] as f32 * keep) as u8;
}

pub fn over_solid(out: &mut [u8], mask: &[u8], color: [f32; 4]) {
    let rgb = [color[0], color[1], color[2]];
    for (px, &m) in out.chunks_exact_mut(4).zip(mask) {
        if m != 0 {
            blend(px, rgb, m as f32 / 255.0 * color[3]);
        }
    }
}

/// The same as `over_solid` for a soft mask, such as a shadow.
pub fn over_soft(out: &mut [u8], mask: &[f32], color: [f32; 4]) {
    let rgb = [color[0], color[1], color[2]];
    for (px, &m) in out.chunks_exact_mut(4).zip(mask) {
        if m > 0.002 {
            blend(px, rgb, m.min(1.0) * color[3]);
        }
    }
}

/// `mask` moved by (dx, dy) and everything on the way there, for a shadow that extrudes.
pub fn extrude(mask: &[u8], w: usize, h: usize, dx: f32, dy: f32) -> Vec<u8> {
    let steps = dx.abs().max(dy.abs()).ceil().max(1.0) as usize;
    let mut out = vec![0u8; w * h];
    for step in 1..=steps {
        let ox = (dx * step as f32 / steps as f32).round() as isize;
        let oy = (dy * step as f32 / steps as f32).round() as isize;
        for y in 0..h as isize {
            let ty = y + oy;
            if ty < 0 || ty >= h as isize {
                continue;
            }
            for x in 0..w as isize {
                let m = mask[(y * w as isize + x) as usize];
                if m == 0 {
                    continue;
                }
                let tx = x + ox;
                if tx < 0 || tx >= w as isize {
                    continue;
                }
                let at = (ty * w as isize + tx) as usize;
                out[at] = out[at].max(m);
            }
        }
    }
    out
}

/// `mask` moved by (dx, dy), without the way there.
pub fn extrude_once(mask: &[u8], w: usize, h: usize, dx: f32, dy: f32) -> Vec<u8> {
    let (ox, oy) = (dx.round() as isize, dy.round() as isize);
    let mut out = vec![0u8; w * h];
    for y in 0..h as isize {
        let sy = y - oy;
        if sy < 0 || sy >= h as isize {
            continue;
        }
        for x in 0..w as isize {
            let sx = x - ox;
            if sx >= 0 && sx < w as isize {
                out[(y * w as isize + x) as usize] = mask[(sy * w as isize + sx) as usize];
            }
        }
    }
    out
}

pub fn union(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b).map(|(&x, &y)| x.max(y)).collect()
}

/// Where each row of the block belongs, so each line can take its own colour.
pub fn lines_of_rows(h: usize, lines: &[(f32, f32)]) -> Vec<u8> {
    (0..h)
        .map(|row| {
            let y = row as f32;
            let mut best = 0usize;
            let mut gap = f32::MAX;
            for (i, (top, bottom)) in lines.iter().enumerate() {
                let d = if y < *top {
                    *top - y
                } else if y > *bottom {
                    y - *bottom
                } else {
                    0.0
                };
                if d < gap {
                    gap = d;
                    best = i;
                }
            }
            best as u8
        })
        .collect()
}

/// A fill, ready to shade pixels. Bounds are the letters' own, so a ramp spans the words and not
/// the empty box around them.
#[derive(Debug, Clone)]
pub struct Paint {
    pub fill: Option<FillSpec>,
    pub solid: [f32; 4],
    pub shine: Option<ShineSpec>,
    pub bevel: f32,
    pub font_px: f32,
    pub bounds: [f32; 4],
    pub lines: Vec<(f32, f32)>,
    pub line_of_row: Vec<u8>,
    /// Soft copy of the mask for bevel and core. Empty when neither is on.
    pub soft: Vec<f32>,
    pub w: usize,
}

impl Paint {
    /// Whether this fill changes from frame to frame.
    pub fn moves(&self) -> bool {
        self.shine.is_some()
            || self
                .fill
                .as_ref()
                .is_some_and(|fill| fill.kind == "plasma" || fill.flow != 0.0)
    }

    fn base(&self, x: f32, y: f32, t: f32) -> [f32; 3] {
        let [x0, y0, x1, _] = self.bounds;
        let line_index = self.line_of_row.get(y as usize).copied().unwrap_or(0) as usize;
        let Some(fill) = self.fill.as_ref() else {
            return [self.solid[0], self.solid[1], self.solid[2]];
        };
        let colors: &[[f32; 3]] = if fill.palettes.is_empty() {
            &[]
        } else {
            &fill.palettes[line_index % fill.palettes.len()]
        };
        if fill.kind == "plasma" {
            let s = std::f32::consts::TAU / (fill.scale.max(0.1) * self.font_px);
            let (u, v) = (x * s, y * s);
            let tt = t * (0.6 + fill.flow);
            // Waves bent by other waves: straight sines read as stripes, not as something alive.
            let a = (u + 1.7 * (v * 0.8 + tt * 0.6).sin() + tt).sin();
            let b = (v * 1.4 + 1.3 * (u * 0.7 - tt * 0.5).sin() - tt * 0.8).sin();
            let c = ((u + v) * 0.7 + tt * 0.4).sin();
            let wave = (a + b + c) / 3.0 * 0.5 + 0.5;
            // There and back, so the ends of the ramp meet.
            let p = (wave * 1.4 + t * 0.07).rem_euclid(1.0);
            return ramp(colors, 1.0 - (2.0 * p - 1.0).abs());
        }
        let rad = fill.angle.to_radians();
        let (cos, sin) = (rad.cos(), rad.sin());
        // Vertical ramps restart on every line: each line is lit on its own, as in a title.
        let (top, bottom) = self.lines.get(line_index).copied().unwrap_or((y0, y0 + 1.0));
        let (ax, ay, bx, by) = (x0, top, x1, bottom);
        let span = ((bx - ax) * cos).abs() + ((by - ay) * sin).abs();
        let at = ((x - ax) * cos + (y - ay) * sin) / span.max(1.0);
        let at = if cos < 0.0 { at + ((bx - ax) * -cos) / span.max(1.0) } else { at };
        if fill.flow != 0.0 {
            let p = (at + t * fill.flow).rem_euclid(1.0);
            return ramp(colors, 1.0 - (2.0 * p - 1.0).abs());
        }
        ramp(colors, at)
    }

    fn at(&self, x: usize, y: usize, t: f32) -> [f32; 3] {
        let (fx, fy) = (x as f32, y as f32);
        let mut rgb = self.base(fx, fy, t);
        if !self.soft.is_empty() {
            let i = y * self.w + x;
            let here = self.soft[i];
            if let Some(core) = self.fill.as_ref().map(|fill| fill.core).filter(|core| *core > 0.0) {
                let k = core * smoothstep(0.62, 1.0, here);
                for c in &mut rgb {
                    *c += (1.0 - *c) * k;
                }
            }
            if self.bevel > 0.0 {
                let left = if x > 0 { self.soft[i - 1] } else { here };
                let right = self.soft.get(i + 1).copied().unwrap_or(here);
                let up = if y > 0 { self.soft[i - self.w] } else { here };
                let down = self.soft.get(i + self.w).copied().unwrap_or(here);
                // Edges facing the top left catch the light, the far ones fall into shade.
                let lit = ((right - left) * 0.5 + (down - up) * 0.7) * self.font_px * 0.09;
                let lit = lit.clamp(-1.0, 1.0) * self.bevel;
                let glint = lit.max(0.0).powi(2);
                for c in &mut rgb {
                    *c = (*c * (1.0 + lit.min(0.0) * 0.7)) + (1.0 - *c) * glint;
                }
            }
        }
        if let Some(shine) = self.shine.as_ref() {
            let k = self.shine_at(shine, fx, fy, t);
            for (c, s) in rgb.iter_mut().zip(shine.color) {
                *c += (s - *c) * k;
            }
        }
        rgb
    }

    fn shine_at(&self, shine: &ShineSpec, x: f32, y: f32, t: f32) -> f32 {
        let [x0, y0, x1, _] = self.bounds;
        let width = shine.em * self.font_px;
        let phase = (t * 1000.0).rem_euclid(shine.period_ms) / shine.sweep_ms.max(1.0);
        if phase >= 1.0 {
            return 0.0;
        }
        let eased = phase * phase * (3.0 - 2.0 * phase);
        let centre = x0 - width * 2.0 + (x1 - x0 + width * 4.0) * eased;
        let d = x + (y - y0) * shine.angle.to_radians().tan() - centre;
        let main = (-(d / width).powi(2)).exp();
        let trail = (-((d + width * 1.7) / (width * 0.32)).powi(2)).exp() * 0.5;
        ((main + trail) * shine.strength).min(1.0)
    }

    /// Shades the letters under `mask` at time `t`, in seconds.
    pub fn draw(&self, out: &mut [u8], mask: &[u8], t: f32) {
        let w = self.w;
        for (i, (px, &m)) in out.chunks_exact_mut(4).zip(mask).enumerate() {
            if m != 0 {
                blend(px, self.at(i % w, i / w, t), m as f32 / 255.0 * self.solid[3]);
            }
        }
    }
}

/// The smallest box round what the mask covers.
pub fn ink_bounds(mask: &[u8], w: usize) -> [f32; 4] {
    let h = mask.len() / w.max(1);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            if mask[y * w + x] > 8 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 {
        return [0.0, 0.0, w as f32, h as f32];
    }
    [x0 as f32, y0 as f32, x1 as f32 + 1.0, y1 as f32 + 1.0]
}

/// The whole block arriving: out of a blur, or wiped in from the left with a soft edge.
pub fn apply_enter(out: &mut [u8], w: usize, h: usize, kind: &str, elapsed_ms: f32, font_px: f32) {
    let t = (elapsed_ms / ENTER_MS).clamp(0.0, 1.0);
    if t >= 1.0 {
        return;
    }
    let e = 1.0 - (1.0 - t) * (1.0 - t);
    match kind {
        "wipe" => {
            let soft = font_px * 1.4;
            let edge = -soft + (w as f32 + soft * 2.0) * e;
            for (i, px) in out.chunks_exact_mut(4).enumerate() {
                let k = 1.0 - smoothstep(edge - soft, edge, (i % w) as f32);
                if k < 1.0 {
                    px.iter_mut().for_each(|c| *c = (*c as f32 * k) as u8);
                }
            }
        }
        _ => {
            let radius = (1.0 - e) * font_px * 0.45;
            for channel in 0..4 {
                let plane: Vec<f32> = out.iter().skip(channel).step_by(4).map(|&v| v as f32).collect();
                let soft = blur(&plane, w, h, radius);
                for (px, v) in out.chunks_exact_mut(4).zip(soft) {
                    px[channel] = (v * e).clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(w: usize, h: usize) -> Vec<f32> {
        let mut m = vec![0.0; w * h];
        m[(h / 2) * w + w / 2] = 1.0;
        m
    }

    #[test]
    fn a_blur_keeps_the_light_it_was_given_and_stays_centred() {
        for radius in [3.0, 12.0, 40.0] {
            let (w, h) = (161, 121);
            let out = blur(&dot(w, h), w, h, radius);
            let total: f32 = out.iter().sum();
            assert!((total - 1.0).abs() < 0.1, "radius {radius}: {total}");
            let peak = out.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
            let (px, py) = ((peak % w) as isize, (peak / w) as isize);
            let slack = (radius / 6.0) as isize + 1;
            assert!((px - 80).abs() <= slack && (py - 60).abs() <= slack, "{px},{py}");
        }
    }

    #[test]
    fn light_adds_to_the_picture_instead_of_covering_it() {
        let mut out = vec![0u8; 4];
        add_light(&mut out, &[0.5], [1.0, 0.0, 0.0], 0.25);
        // Red is the third byte; far more colour than alpha is what makes it additive.
        assert!(out[2] > 120, "{out:?}");
        assert!(out[3] < 50, "{out:?}");
    }

    #[test]
    fn a_pop_rises_past_the_peak_moment_and_settles_on_the_hold() {
        assert_eq!(pop_scale(0.0, 1.3, 1.1), 1.0);
        assert!((pop_scale(80.0, 1.3, 1.1) - 1.3).abs() < 1e-3);
        assert!((pop_scale(POP_WINDOW_MS, 1.3, 1.1) - 1.1).abs() < 1e-3);
    }

    fn paint(fill: FillSpec) -> Paint {
        Paint {
            fill: Some(fill),
            solid: [1.0, 1.0, 1.0, 1.0],
            shine: None,
            bevel: 0.0,
            font_px: 40.0,
            bounds: [0.0, 0.0, 100.0, 100.0],
            lines: vec![(0.0, 40.0), (50.0, 100.0)],
            line_of_row: lines_of_rows(100, &[(0.0, 40.0), (50.0, 100.0)]),
            soft: Vec::new(),
            w: 100,
        }
    }

    #[test]
    fn a_vertical_ramp_starts_again_on_each_line_with_its_own_colours() {
        let blue = [0.0, 0.0, 1.0];
        let pink = [1.0, 0.0, 1.0];
        let white = [1.0, 1.0, 1.0];
        let p = paint(FillSpec {
            kind: "gradient".into(),
            palettes: vec![vec![white, blue], vec![white, pink]],
            angle: 90.0,
            ..Default::default()
        });
        assert!(p.at(10, 0, 0.0)[1] > 0.99);
        assert!(p.at(10, 50, 0.0)[1] > 0.99);
        let low_first = p.at(10, 39, 0.0);
        let low_second = p.at(10, 99, 0.0);
        assert!(low_first[0] < 0.1 && low_first[2] > 0.9, "{low_first:?}");
        assert!(low_second[0] > 0.9 && low_second[1] < 0.1, "{low_second:?}");
    }

    #[test]
    fn plasma_moves_with_time_and_repeats_exactly_at_the_same_time() {
        let p = paint(FillSpec {
            kind: "plasma".into(),
            palettes: vec![vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]],
            scale: 1.0,
            ..Default::default()
        });
        assert_eq!(p.at(30, 30, 1.25), p.at(30, 30, 1.25));
        assert_ne!(p.at(30, 30, 0.0), p.at(30, 30, 1.0));
    }

    #[test]
    fn a_shine_passes_once_and_leaves_the_rest_of_the_period_alone() {
        let shine = ShineSpec {
            color: [1.0, 1.0, 1.0],
            period_ms: 3000.0,
            sweep_ms: 900.0,
            em: 0.4,
            angle: 20.0,
            strength: 1.0,
        };
        let p = paint(FillSpec::default());
        let during = (0..100).map(|x| p.shine_at(&shine, x as f32, 20.0, 0.45)).fold(0.0, f32::max);
        let after = (0..100).map(|x| p.shine_at(&shine, x as f32, 20.0, 2.0)).fold(0.0, f32::max);
        assert!(during > 0.5, "{during}");
        assert_eq!(after, 0.0);
    }

    #[test]
    fn extruding_reaches_the_whole_way_without_gaps() {
        let (w, h) = (20, 20);
        let mut m = vec![0u8; w * h];
        m[2 * w + 2] = 255;
        let out = extrude(&m, w, h, 5.0, 5.0);
        for step in 1..=5 {
            assert_eq!(out[(2 + step) * w + 2 + step], 255, "step {step}");
        }
    }
}
