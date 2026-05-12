use std::time::Duration;

/// Default relay warning threshold: 8 minutes.
pub const DEFAULT_WARNING: Duration = Duration::from_secs(8 * 60);

/// Default relay cutoff threshold: 10 minutes.
pub const DEFAULT_CUTOFF: Duration = Duration::from_secs(10 * 60);

/// Configuration for the free-tier relay timer.
pub struct TimerConfig {
    pub warning: Duration,
    pub cutoff: Duration,
}

impl Default for TimerConfig {
    fn default() -> Self {
        Self {
            warning: DEFAULT_WARNING,
            cutoff: DEFAULT_CUTOFF,
        }
    }
}

/// Cancellation handle for a running free-tier timer.
///
/// `cancel()` aborts both the warning and cutoff sleep tasks so they cannot
/// fire after the session ends. Without this, a disconnect followed quickly
/// by a new session would have the previous session's `cutoff` fire against
/// the new one (gh #63).
///
/// We hold the `JoinHandle`s themselves rather than `AbortHandle`s because
/// `tauri::async_runtime::JoinHandle` does not expose `abort_handle()` — but
/// it does expose `abort()`, which is all `cancel()` needs.
pub struct TimerHandles {
    warning: tauri::async_runtime::JoinHandle<()>,
    cutoff: tauri::async_runtime::JoinHandle<()>,
}

impl TimerHandles {
    pub fn cancel(self) {
        self.warning.abort();
        self.cutoff.abort();
    }
}

/// Start the two-stage free-tier relay timer.
///
/// Spawns two `tokio::time::sleep` tasks using the provided `tauri::AppHandle`
/// runtime.  The first fires `on_warning` at `cfg.warning`; the second fires
/// `on_cutoff` at `cfg.cutoff`.
///
/// Returns a `TimerHandles` that the caller must hold for the lifetime of
/// the session and call `.cancel()` on at teardown.  Both closures are
/// `FnOnce + Send + 'static` so they can be moved into async tasks
/// without lifetime issues.
pub fn start<W, C>(cfg: TimerConfig, on_warning: W, on_cutoff: C) -> TimerHandles
where
    W: FnOnce() + Send + 'static,
    C: FnOnce() + Send + 'static,
{
    let warning_dur = cfg.warning;
    let cutoff_dur = cfg.cutoff;

    let warning = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(warning_dur).await;
        on_warning();
    });

    let cutoff = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(cutoff_dur).await;
        on_cutoff();
    });

    TimerHandles { warning, cutoff }
}

/// Pure helper: produce the durations that would be used for warning and cutoff.
///
/// Extracted so unit tests can verify the timing logic without spawning actual
/// async tasks.
#[cfg(test)]
pub fn timer_durations(cfg: &TimerConfig) -> (Duration, Duration) {
    (cfg.warning, cfg.cutoff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_correct_warning_duration() {
        let cfg = TimerConfig::default();
        assert_eq!(cfg.warning, Duration::from_secs(8 * 60));
    }

    #[test]
    fn default_config_has_correct_cutoff_duration() {
        let cfg = TimerConfig::default();
        assert_eq!(cfg.cutoff, Duration::from_secs(10 * 60));
    }

    #[test]
    fn custom_config_overrides_durations() {
        let cfg = TimerConfig {
            warning: Duration::from_secs(30),
            cutoff: Duration::from_secs(60),
        };
        let (w, c) = timer_durations(&cfg);
        assert_eq!(w, Duration::from_secs(30));
        assert_eq!(c, Duration::from_secs(60));
    }

    #[test]
    fn warning_is_before_cutoff_in_default_config() {
        let cfg = TimerConfig::default();
        assert!(cfg.warning < cfg.cutoff);
    }
}
