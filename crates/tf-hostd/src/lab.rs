//! Fault injection for labs (cargo feature `lab-faults`) and tests; never part of a release build.
//!
//! `TF_HOSTD_LAB_FREEZE=<text>`: the first live frame (bridge feed or collab room) whose event
//! JSON contains `<text>` freezes the live source of its session, once. A bridge feed driver then
//! hangs where it is, as one stuck in an await nothing interrupts would (only the settle watchdog's
//! restart gets past it); a collab room's frames are dropped until its next snapshot, as from a room
//! that went silent until it was asked for everything again. The session file and omp's other words
//! (control state, collab registry) go on as before, so the settle watchdog ([`crate::settle`]) has
//! to find and repair the copy. Tests arm the same freeze with [`arm`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use tf_collab::HostFrame;

/// Texts still armed, each going off once.
static ARMED: LazyLock<Mutex<Vec<String>>> =
    LazyLock::new(|| Mutex::new(std::env::var("TF_HOSTD_LAB_FREEZE").ok().filter(|t| !t.is_empty()).into_iter().collect()));
/// Nothing is armed (the common case: no lock per frame).
static IDLE: AtomicBool = AtomicBool::new(false);

/// Arms one more freeze at the first live frame whose event JSON contains `text`.
#[cfg(test)]
pub(crate) fn arm(text: &str) {
    ARMED.lock().unwrap_or_else(|p| p.into_inner()).push(text.to_owned());
    IDLE.store(false, Ordering::Relaxed);
}

/// `frame` is where an armed freeze goes off (each one once).
pub(crate) fn freezes(frame: &HostFrame) -> bool {
    if IDLE.load(Ordering::Relaxed) {
        return false;
    }
    let HostFrame::Event { event } = frame else { return false };
    let mut armed = ARMED.lock().unwrap_or_else(|p| p.into_inner());
    if armed.is_empty() {
        IDLE.store(true, Ordering::Relaxed);
        return false;
    }
    let json = event.to_string();
    match armed.iter().position(|t| json.contains(t.as_str())) {
        Some(i) => {
            armed.remove(i);
            true
        }
        None => false,
    }
}
