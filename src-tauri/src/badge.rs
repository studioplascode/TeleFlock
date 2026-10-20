//! Tiny RGBA rasteriser for the tray icon and the taskbar overlay badge (no image deps).
//!
//! * Tray: the app icon; while agents run, a comet arc orbits its edge (animated frames); when
//!   agents need you, a pink count badge sits in the lower-right corner.
//! * Taskbar overlay: a pink count disc (needs you) or a purple dot (running), else none.

pub const SIZE: u32 = 32;
const N: usize = (SIZE * SIZE) as usize;

/// Colours from `src/design/tokens.ts`.
const RUN_A: [u8; 3] = [0xa3, 0x5c, 0xf0];
const RUN_B: [u8; 3] = [0x4f, 0x8b, 0xff];
const NEEDS: [u8; 3] = [0xff, 0x3d, 0x77];
const INK: [u8; 3] = [0xff, 0xff, 0xff];
const OUTLINE: [u8; 3] = [0x0b, 0x0b, 0x10];

/// Frames per orbit of the running comet.
pub const FRAMES: usize = 12;

pub struct Canvas(pub Vec<u8>);

impl Canvas {
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub fn blank() -> Self {
        Self(vec![0; N * 4])
    }

    pub fn from_rgba(rgba: &[u8]) -> Self {
        assert_eq!(rgba.len(), N * 4, "badge canvas must be {SIZE}x{SIZE} RGBA");
        Self(rgba.to_vec())
    }

    /// Source-over blend of a straight-alpha colour with `alpha` in 0..=1.
    fn blend(&mut self, x: u32, y: u32, c: [u8; 3], alpha: f32) {
        if alpha <= 0.0 || x >= SIZE || y >= SIZE {
            return;
        }
        let a = alpha.min(1.0);
        let i = ((y * SIZE + x) * 4) as usize;
        let px = &mut self.0[i..i + 4];
        let da = px[3] as f32 / 255.0;
        let out_a = a + da * (1.0 - a);
        for k in 0..3 {
            let dc = px[k] as f32 / 255.0;
            let sc = c[k] as f32 / 255.0;
            let v = if out_a > 0.0 { (sc * a + dc * da * (1.0 - a)) / out_a } else { 0.0 };
            px[k] = (v * 255.0).round() as u8;
        }
        px[3] = (out_a * 255.0).round() as u8;
    }

    /// Anti-aliased filled disc.
    fn disc(&mut self, cx: f32, cy: f32, r: f32, c: [u8; 3]) {
        for y in 0..SIZE {
            for x in 0..SIZE {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                self.blend(x, y, c, (r - d + 0.5).clamp(0.0, 1.0));
            }
        }
    }

    /// Comet arc on a circle of radius `r`: the head at angle `head` (radians, clockwise from
    /// 12 o'clock), fading over `len` radians behind it, colour sweeping RUN_A → RUN_B.
    fn comet(&mut self, r: f32, width: f32, head: f32, len: f32) {
        let c = SIZE as f32 / 2.0;
        let tau = std::f32::consts::TAU;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
                let radial = (width / 2.0 - ((dx * dx + dy * dy).sqrt() - r).abs() + 0.5).clamp(0.0, 1.0);
                if radial <= 0.0 {
                    continue;
                }
                let ang = dx.atan2(-dy).rem_euclid(tau);
                let behind = (head - ang).rem_euclid(tau);
                if behind > len {
                    continue;
                }
                let t = 1.0 - behind / len; // 1 at the head, 0 at the tail
                let col = [0, 1, 2].map(|k| (RUN_B[k] as f32 + (RUN_A[k] as f32 - RUN_B[k] as f32) * t) as u8);
                self.blend(x, y, col, radial * t.powf(0.8));
            }
        }
    }

    /// Pixel glyphs (3x5 font) scaled by `s`, centred on (`cx`, `cy`).
    fn text(&mut self, text: &str, cx: f32, cy: f32, s: u32, c: [u8; 3]) {
        let glyphs: Vec<[u8; 5]> = text.chars().filter_map(glyph).collect();
        if glyphs.is_empty() {
            return;
        }
        let w = glyphs.len() as u32 * 3 * s + (glyphs.len() as u32 - 1) * s;
        let x0 = (cx - w as f32 / 2.0).round() as i32;
        let y0 = (cy - (5 * s) as f32 / 2.0).round() as i32;
        for (gi, g) in glyphs.iter().enumerate() {
            let gx = x0 + (gi as u32 * 4 * s) as i32;
            for (row, bits) in g.iter().enumerate() {
                for col in 0..3 {
                    if bits & (0b100 >> col) == 0 {
                        continue;
                    }
                    for dy in 0..s {
                        for dx in 0..s {
                            let (px, py) = (gx + (col * s + dx) as i32, y0 + (row as u32 * s + dy) as i32);
                            if px >= 0 && py >= 0 {
                                self.blend(px as u32, py as u32, c, 1.0);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn glyph(c: char) -> Option<[u8; 5]> {
    Some(match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => return None,
    })
}

fn count_label(n: u32) -> String {
    if n > 9 { "9+".to_owned() } else { n.to_string() }
}

/// One tray frame. `frame` selects the comet position (ignored when nothing runs).
pub fn tray(base: &[u8], running: bool, needs: u32, frame: usize) -> Vec<u8> {
    let mut c = Canvas::from_rgba(base);
    if running {
        let head = std::f32::consts::TAU * (frame % FRAMES) as f32 / FRAMES as f32;
        c.comet(14.6, 2.6, head, std::f32::consts::PI * 1.1);
    }
    if needs > 0 {
        let (cx, cy, r) = (22.5, 22.5, 9.0);
        c.disc(cx, cy, r + 1.5, OUTLINE);
        c.disc(cx, cy, r, NEEDS);
        c.text(&count_label(needs), cx, cy, 2, INK);
    }
    c.0
}

/// Taskbar overlay badge; `None` clears it.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn overlay(running: u32, needs: u32) -> Option<Vec<u8>> {
    let mut c = Canvas::blank();
    let mid = SIZE as f32 / 2.0;
    if needs > 0 {
        c.disc(mid, mid, 15.5, OUTLINE);
        c.disc(mid, mid, 14.0, NEEDS);
        c.text(&count_label(needs), mid, mid, 3, INK);
    } else if running > 0 {
        c.disc(mid, mid, 11.0, OUTLINE);
        c.disc(mid, mid, 9.5, RUN_A);
        c.disc(mid, mid, 4.0, INK);
    } else {
        return None;
    }
    Some(c.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn idle_tray_is_the_base_icon() {
        let base: Vec<u8> = (0..N * 4).map(|i| (i % 251) as u8).collect();
        assert_eq!(tray(&base, false, 0, 3), base);
    }

    #[test]
    fn needs_badge_is_pink_with_white_digit() {
        let out = tray(&Canvas::blank().0, false, 3, 0);
        // Badge edge (inside the disc, away from the glyph).
        assert_eq!(px(&out, 22, 15), [NEEDS[0], NEEDS[1], NEEDS[2], 255]);
        // Top-left pixel of the "3" glyph (6x10 at scale 2 centred on 22.5,22.5).
        assert_eq!(px(&out, 20, 18), [255, 255, 255, 255]);
        // Far corner untouched.
        assert_eq!(px(&out, 0, 0)[3], 0);
    }

    #[test]
    fn comet_moves_between_frames() {
        let a = tray(&Canvas::blank().0, true, 0, 0);
        let b = tray(&Canvas::blank().0, true, 0, FRAMES / 2);
        assert_ne!(a, b);
        // Head at 12 o'clock on frame 0, tail trailing counter-clockwise: just left of top is lit.
        assert!(px(&a, 15, 1)[3] > 150);
        // 3 o'clock is ahead of the head (clockwise) and stays dark.
        assert_eq!(px(&a, 30, 16)[3], 0);
    }

    #[test]
    fn overlay_states() {
        assert!(overlay(0, 0).is_none());
        let run = overlay(2, 0).unwrap();
        assert_eq!(px(&run, 16, 16), [255, 255, 255, 255]);
        let needs = overlay(5, 12).unwrap();
        assert_eq!(px(&needs, 16, 3), [NEEDS[0], NEEDS[1], NEEDS[2], 255]);
    }
}
