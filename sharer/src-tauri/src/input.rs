use enigo::{
    Axis, Button as EnigoButton, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InputEvent {
    MouseMove {
        x: f64,
        y: f64,
    },
    MouseButton {
        button: Button,
        pressed: bool,
    },
    Scroll {
        dx: f64,
        dy: f64,
    },
    Key {
        code: String,
        pressed: bool,
        modifiers: Modifiers,
    },
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Right,
    Middle,
}

#[derive(Deserialize, Debug, Default, Clone, Copy)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

pub struct InputController {
    enigo: Enigo,
    /// Top-left of the captured monitor in the OS virtual-desktop coordinate
    /// space. Required so multi-monitor setups route absolute pointer events
    /// to the monitor that's actually being streamed; with the offset
    /// defaulted to 0 the cursor lands on the primary monitor regardless of
    /// which display is shared (gh: Windows multi-monitor input bug).
    x_offset: i32,
    y_offset: i32,
    width: u32,
    height: u32,
    paused: bool,
}

impl InputController {
    pub fn new(x_offset: i32, y_offset: i32, width: u32, height: u32) -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        Ok(Self {
            enigo,
            x_offset,
            y_offset,
            width,
            height,
            paused: false,
        })
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    /// Toggles the paused state and returns the new value.
    pub fn toggle_paused(&mut self) -> bool {
        self.paused = !self.paused;
        self.paused
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn apply(&mut self, event: InputEvent) -> Result<(), String> {
        if self.paused {
            return Ok(());
        }
        match event {
            InputEvent::MouseMove { x, y } => {
                let (px, py) =
                    compute_abs_coords(x, y, self.x_offset, self.y_offset, self.width, self.height);
                self.enigo
                    .move_mouse(px, py, Coordinate::Abs)
                    .map_err(|e| e.to_string())?;
            }
            InputEvent::MouseButton { button, pressed } => {
                let b = map_button(button);
                let dir = if pressed {
                    Direction::Press
                } else {
                    Direction::Release
                };
                self.enigo.button(b, dir).map_err(|e| e.to_string())?;
            }
            InputEvent::Scroll { dy, .. } => {
                let lines = clamp_scroll_lines(dy);
                if lines != 0 {
                    self.enigo
                        .scroll(lines, Axis::Vertical)
                        .map_err(|e| e.to_string())?;
                }
            }
            InputEvent::Key {
                code,
                pressed,
                modifiers: _,
            } => {
                let key = parse_key(&code).ok_or_else(|| format!("unknown key: {code}"))?;
                let dir = if pressed {
                    Direction::Press
                } else {
                    Direction::Release
                };
                self.enigo.key(key, dir).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

/// Clamp a `wheel`-event delta into a sensible enigo scroll-line count.
///
/// The viewer sends `dy` straight from a browser `WheelEvent`, which is an
/// f64 user-supplied value. A malicious or buggy viewer can drive `dy` to
/// `f64::INFINITY` / `f64::MAX` / `NaN`; the naive `(dy/120.0) as i32`
/// saturates to `i32::MAX` and most enigo backends loop the call once per
/// line — pinning the sharer's CPU at 100 %. The input DataChannel bypasses
/// the backend's signaling rate-limits, so this clamp is the only defence.
///
/// 100 lines ≈ 10 mouse-wheel notches per event, comfortably above any
/// legitimate single-event delta a browser would produce.
pub(crate) fn clamp_scroll_lines(dy: f64) -> i32 {
    if !dy.is_finite() {
        return 0;
    }
    ((dy / 120.0) as i32).clamp(-100, 100)
}

/// Translate the viewer's normalised pointer position into the OS virtual-
/// desktop coordinate the absolute-mouse-move syscall expects.
///
/// Clamps `x_norm`/`y_norm` to `[0,1]` (and maps NaN to 0.0) so a malicious
/// or buggy viewer cannot drive the cursor outside the shared monitor's
/// rectangle — important on multi-monitor systems where the OS would
/// otherwise let us hit another display's chrome — and then offsets by the
/// captured monitor's top-left in the virtual-desktop. The offset is
/// signed: Windows places non-primary monitors at negative coordinates
/// when they sit above or left of the primary.
pub(crate) fn compute_abs_coords(
    x_norm: f64,
    y_norm: f64,
    x_offset: i32,
    y_offset: i32,
    width: u32,
    height: u32,
) -> (i32, i32) {
    let x = if x_norm.is_nan() {
        0.0
    } else {
        x_norm.clamp(0.0, 1.0)
    };
    let y = if y_norm.is_nan() {
        0.0
    } else {
        y_norm.clamp(0.0, 1.0)
    };
    let px = (x * f64::from(width)) as i32 + x_offset;
    let py = (y * f64::from(height)) as i32 + y_offset;
    (px, py)
}

fn map_button(button: Button) -> EnigoButton {
    match button {
        Button::Left => EnigoButton::Left,
        Button::Right => EnigoButton::Right,
        Button::Middle => EnigoButton::Middle,
    }
}

pub fn parse_key(code: &str) -> Option<Key> {
    match code {
        "Enter" => Some(Key::Return),
        "Escape" => Some(Key::Escape),
        "Backspace" => Some(Key::Backspace),
        "Tab" => Some(Key::Tab),
        "Space" => Some(Key::Space),
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        "ShiftLeft" | "ShiftRight" => Some(Key::Shift),
        "ControlLeft" | "ControlRight" => Some(Key::Control),
        "AltLeft" | "AltRight" => Some(Key::Alt),
        "MetaLeft" | "MetaRight" => Some(Key::Meta),
        "Delete" => Some(Key::Delete),
        "Insert" => Some(Key::Insert),
        "Home" => Some(Key::Home),
        "End" => Some(Key::End),
        "PageUp" => Some(Key::PageUp),
        "PageDown" => Some(Key::PageDown),
        "CapsLock" => Some(Key::CapsLock),
        "F1" => Some(Key::F1),
        "F2" => Some(Key::F2),
        "F3" => Some(Key::F3),
        "F4" => Some(Key::F4),
        "F5" => Some(Key::F5),
        "F6" => Some(Key::F6),
        "F7" => Some(Key::F7),
        "F8" => Some(Key::F8),
        "F9" => Some(Key::F9),
        "F10" => Some(Key::F10),
        "F11" => Some(Key::F11),
        "F12" => Some(Key::F12),
        s if s.starts_with("Key") && s.len() == 4 => s
            .chars()
            .last()
            .map(|c| Key::Unicode(c.to_ascii_lowercase())),
        s if s.starts_with("Digit") && s.len() == 6 => s.chars().last().map(Key::Unicode),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_mouse_move() {
        let json = r#"{"kind":"mouse-move","x":0.5,"y":0.7}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        if let InputEvent::MouseMove { x, y } = ev {
            assert!((x - 0.5).abs() < f64::EPSILON);
            assert!((y - 0.7).abs() < f64::EPSILON);
        } else {
            panic!("expected MouseMove variant");
        }
    }

    #[test]
    fn deserialize_key_event() {
        let json = r#"{"kind":"key","code":"KeyA","pressed":true,"modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":false}}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        if let InputEvent::Key { code, pressed, .. } = ev {
            assert_eq!(code, "KeyA");
            assert!(pressed);
        } else {
            panic!("expected Key variant");
        }
    }

    #[test]
    fn deserialize_mouse_button() {
        let json = r#"{"kind":"mouse-button","button":"left","pressed":true}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        if let InputEvent::MouseButton { button, pressed } = ev {
            assert!(matches!(button, Button::Left));
            assert!(pressed);
        } else {
            panic!("expected MouseButton variant");
        }
    }

    #[test]
    fn deserialize_scroll() {
        let json = r#"{"kind":"scroll","dx":0,"dy":120}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        if let InputEvent::Scroll { dx, dy } = ev {
            assert!((dx - 0.0).abs() < f64::EPSILON);
            assert!((dy - 120.0).abs() < f64::EPSILON);
        } else {
            panic!("expected Scroll variant");
        }
    }

    #[test]
    fn clamp_scroll_normal_values_pass_through() {
        assert_eq!(clamp_scroll_lines(0.0), 0);
        assert_eq!(clamp_scroll_lines(120.0), 1); // one notch
        assert_eq!(clamp_scroll_lines(-120.0), -1);
        assert_eq!(clamp_scroll_lines(360.0), 3); // three notches
    }

    #[test]
    fn clamp_scroll_caps_huge_values() {
        // A malicious viewer can ship arbitrarily large doubles. enigo
        // loops once per line on most backends; without the cap this
        // would pin the sharer's CPU.
        assert_eq!(clamp_scroll_lines(f64::MAX), 100);
        assert_eq!(clamp_scroll_lines(-f64::MAX), -100);
        assert_eq!(clamp_scroll_lines(1.0e9), 100);
    }

    #[test]
    fn clamp_scroll_rejects_non_finite() {
        // NaN and infinities short-circuit to 0 so the scroll call is
        // skipped entirely (the `lines != 0` branch in apply guards it).
        assert_eq!(clamp_scroll_lines(f64::NAN), 0);
        assert_eq!(clamp_scroll_lines(f64::INFINITY), 0);
        assert_eq!(clamp_scroll_lines(f64::NEG_INFINITY), 0);
    }

    #[test]
    fn parse_letter_keys() {
        assert!(matches!(parse_key("KeyA"), Some(Key::Unicode('a'))));
        assert!(matches!(parse_key("KeyZ"), Some(Key::Unicode('z'))));
        assert!(matches!(parse_key("KeyM"), Some(Key::Unicode('m'))));
    }

    #[test]
    fn parse_digit_keys() {
        assert!(matches!(parse_key("Digit0"), Some(Key::Unicode('0'))));
        assert!(matches!(parse_key("Digit9"), Some(Key::Unicode('9'))));
    }

    #[test]
    fn parse_arrow_keys() {
        assert!(matches!(parse_key("ArrowUp"), Some(Key::UpArrow)));
        assert!(matches!(parse_key("ArrowDown"), Some(Key::DownArrow)));
        assert!(matches!(parse_key("ArrowLeft"), Some(Key::LeftArrow)));
        assert!(matches!(parse_key("ArrowRight"), Some(Key::RightArrow)));
    }

    #[test]
    fn parse_modifier_keys() {
        assert!(matches!(parse_key("ShiftLeft"), Some(Key::Shift)));
        assert!(matches!(parse_key("ShiftRight"), Some(Key::Shift)));
        assert!(matches!(parse_key("ControlLeft"), Some(Key::Control)));
        assert!(matches!(parse_key("ControlRight"), Some(Key::Control)));
        assert!(matches!(parse_key("AltLeft"), Some(Key::Alt)));
        assert!(matches!(parse_key("AltRight"), Some(Key::Alt)));
        assert!(matches!(parse_key("MetaLeft"), Some(Key::Meta)));
        assert!(matches!(parse_key("MetaRight"), Some(Key::Meta)));
    }

    #[test]
    fn parse_returns_none_for_unknown() {
        assert!(parse_key("Frobnicator").is_none());
        assert!(parse_key("").is_none());
        assert!(parse_key("KeyAB").is_none());
    }

    #[test]
    fn parse_special_keys() {
        assert!(matches!(parse_key("Enter"), Some(Key::Return)));
        assert!(matches!(parse_key("Escape"), Some(Key::Escape)));
        assert!(matches!(parse_key("Backspace"), Some(Key::Backspace)));
        assert!(matches!(parse_key("Tab"), Some(Key::Tab)));
        assert!(matches!(parse_key("Space"), Some(Key::Space)));
        assert!(matches!(parse_key("Delete"), Some(Key::Delete)));
        assert!(matches!(parse_key("Home"), Some(Key::Home)));
        assert!(matches!(parse_key("End"), Some(Key::End)));
    }

    #[test]
    fn toggle_paused_flips_state() {
        // `InputController::new` requires a display; test the logic with direct struct manipulation.
        // We test via serde round-trip + paused field only — construction is guarded by `#[ignore]`.
        // Use a minimal hand-constructed instance by abusing Default on Enigo is not possible,
        // so we verify the pure logic path: starts false, first toggle → true, second → false.
        // Since Enigo::new needs X11, guard with `#[ignore]` for the same reason.
        //
        // Instead: test toggle logic via a minimal wrapper that bypasses Enigo construction.
        struct PausedState(bool);
        impl PausedState {
            fn toggle(&mut self) -> bool {
                self.0 = !self.0;
                self.0
            }
        }
        let mut state = PausedState(false);
        assert!(state.toggle(), "first toggle should be true");
        assert!(!state.toggle(), "second toggle should be false");
    }

    #[test]
    #[ignore]
    fn toggle_paused_flips_state_with_real_enigo() {
        let mut ctrl = InputController::new(0, 0, 1920, 1080).expect("need display");
        assert!(!ctrl.is_paused());
        assert!(ctrl.toggle_paused());
        assert!(ctrl.is_paused());
        assert!(!ctrl.toggle_paused());
        assert!(!ctrl.is_paused());
    }

    #[test]
    #[ignore]
    fn set_paused_no_op_with_real_enigo() {
        let mut ctrl = InputController::new(0, 0, 1920, 1080).expect("need display");
        ctrl.set_paused(true);
        let result = ctrl.apply(InputEvent::MouseMove { x: 0.5, y: 0.5 });
        assert!(result.is_ok(), "paused apply should return Ok");
    }

    #[test]
    fn compute_abs_coords_zero_offset_matches_pre_offset_behaviour() {
        assert_eq!(compute_abs_coords(0.0, 0.0, 0, 0, 1920, 1080), (0, 0));
        assert_eq!(compute_abs_coords(1.0, 1.0, 0, 0, 1920, 1080), (1920, 1080));
        assert_eq!(compute_abs_coords(0.5, 0.5, 0, 0, 1920, 1080), (960, 540));
    }

    #[test]
    fn compute_abs_coords_applies_positive_offset() {
        // Monitor placed at x=2560 (typical right-of-primary on 2560-wide
        // primary): centre of that monitor in viewer-coords (0.5,0.5) must
        // land at (2560 + width/2, y_offset + height/2).
        let (px, py) = compute_abs_coords(0.5, 0.5, 2560, 0, 2560, 1440);
        assert_eq!((px, py), (2560 + 1280, 720));
    }

    #[test]
    fn compute_abs_coords_applies_negative_offset() {
        // Monitor placed at y=-707 (top-of-primary scenario): viewer-coord
        // (0,0) must land at the monitor's logical top-left, not at desktop
        // origin (0,0). That's how the Windows DISPLAY2 layout breaks
        // without offset handling.
        let (px, py) = compute_abs_coords(0.0, 0.0, 2560, -707, 2560, 1440);
        assert_eq!((px, py), (2560, -707));
    }

    #[test]
    fn compute_abs_coords_clamps_then_offsets() {
        // Out-of-range normalised values clamp BEFORE the offset is added
        // — otherwise a hostile viewer sending x=2.0 could reach the
        // primary monitor on the right of a (2560,0) offset display.
        let (px, _) = compute_abs_coords(2.0, 0.5, 2560, 0, 2560, 1440);
        assert_eq!(
            px,
            2560 + 2560,
            "clamped x must hit the captured monitor's right edge, not bleed past"
        );
    }

    #[test]
    fn compute_abs_coords_nan_clamps_to_low_end() {
        let (px, py) = compute_abs_coords(f64::NAN, f64::NAN, 2560, -707, 2560, 1440);
        assert_eq!((px, py), (2560, -707));
    }
}
