//! Moving a live session from one window to another (TRM-02, detach a tab to its own window).
//!
//! A session's output goes through a [`Relay`], which the session task treats as its sink. The
//! relay also owns the output flow-control count (INV-12), split into epochs: each handoff
//! starts a new epoch, and acknowledgements carry the epoch they were authorized in, so a late
//! acknowledgement from the old window never credits output the new window has not seen.
//!
//! A handoff is offered by the owning window for one named target window. From the offer on,
//! output and events are held (bounded: output by the unacknowledged-output limit, events by a
//! count), so nothing produced while the target window starts is lost or shown in the old one.
//! Accepting swaps the sink and the owner together; an offer that is not accepted in time, or
//! whose target window closes, releases what was held to the owner, which keeps the session.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tyrminal_contracts::SessionEvent;

use crate::sessions::SessionSink;

/// How long an offer waits for the target window to accept it.
pub(crate) const HANDOFF_TTL: Duration = Duration::from_secs(30);

/// Events held during a handoff before the session is ended instead (a session that produces
/// this many state changes while its window moves is not behaving like a terminal).
const MAX_HELD_EVENTS: usize = 64;

enum Held {
    Output(Vec<u8>),
    Event(SessionEvent),
}

struct State {
    sink: Arc<dyn SessionSink>,
    epoch: u64,
    /// Output handed to (or held for) the current window and not yet acknowledged by it.
    unacked: usize,
    held: Option<Vec<Held>>,
    held_events: usize,
}

pub(crate) struct Relay {
    state: Mutex<State>,
    /// Counts the batches of terminal output the session produced, so startup typing can wait
    /// for the shell (see `sessions::settle`).
    activity: tokio::sync::watch::Sender<u64>,
}

impl Relay {
    pub(crate) fn new(sink: Arc<dyn SessionSink>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State { sink, epoch: 0, unacked: 0, held: None, held_events: 0 }),
            activity: tokio::sync::watch::Sender::new(0),
        })
    }

    /// Notes that the session produced terminal output.
    pub(crate) fn note_output(&self) {
        self.activity.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Changes whenever the session produces terminal output.
    pub(crate) fn output_activity(&self) -> tokio::sync::watch::Receiver<u64> {
        self.activity.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.lock().epoch
    }

    pub(crate) fn unacked(&self) -> usize {
        self.lock().unacked
    }

    /// Credits `bytes` acknowledged by the window that owned the session in `epoch`.
    pub(crate) fn ack(&self, epoch: u64, bytes: usize) {
        let mut state = self.lock();
        if state.epoch == epoch {
            state.unacked = state.unacked.saturating_sub(bytes);
        }
    }

    /// Starts holding output and events for a window that is about to take the session.
    pub(crate) fn hold(&self) {
        let mut state = self.lock();
        if state.held.is_none() {
            state.held = Some(Vec::new());
            state.held_events = 0;
        }
    }

    /// The offer lapsed: what was held goes to the current window after all.
    pub(crate) fn release(&self) {
        let mut state = self.lock();
        if let Some(held) = state.held.take() {
            flush(&*state.sink, held);
        }
    }

    /// Hands the session to `sink`: a new epoch whose outstanding output is exactly what was
    /// held for it (which is delivered now, in order). Output the old window received and did
    /// not acknowledge no longer counts; that window no longer receives anything.
    pub(crate) fn switch(&self, sink: Arc<dyn SessionSink>) {
        let mut state = self.lock();
        let held = state.held.take().unwrap_or_default();
        state.epoch += 1;
        state.unacked = held.iter().map(|h| if let Held::Output(d) = h { d.len() } else { 0 }).sum();
        state.sink = sink;
        flush(&*state.sink, held);
    }
}

fn flush(sink: &dyn SessionSink, held: Vec<Held>) {
    for item in held {
        // A receiver that is gone ends the session on the next delivery, as usual.
        let _ = match item {
            Held::Output(data) => sink.output(data),
            Held::Event(event) => sink.event(event),
        };
    }
}

impl SessionSink for Relay {
    fn output(&self, data: Vec<u8>) -> bool {
        let mut state = self.lock();
        state.unacked += data.len();
        match state.held.as_mut() {
            Some(held) => {
                held.push(Held::Output(data));
                true
            }
            None => state.sink.output(data),
        }
    }

    fn event(&self, event: SessionEvent) -> bool {
        let mut state = self.lock();
        if state.held.is_some() {
            if state.held_events >= MAX_HELD_EVENTS {
                return false;
            }
            state.held_events += 1;
            state.held.get_or_insert_with(Vec::new).push(Held::Event(event));
            return true;
        }
        state.sink.event(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tyrminal_contracts::SessionState;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    impl SessionSink for Recorder {
        fn output(&self, data: Vec<u8>) -> bool {
            self.0.lock().unwrap().push(String::from_utf8(data).unwrap());
            true
        }
        fn event(&self, _: SessionEvent) -> bool {
            self.0.lock().unwrap().push("event".into());
            true
        }
    }

    fn seen(r: &Recorder) -> Vec<String> {
        r.0.lock().unwrap().clone()
    }

    #[test]
    fn held_output_goes_to_the_new_window_in_order_and_old_acks_are_ignored() {
        let (old, new) = (Arc::new(Recorder::default()), Arc::new(Recorder::default()));
        let relay = Relay::new(old.clone());
        assert!(relay.output(b"a".to_vec()));
        assert_eq!(relay.unacked(), 1);
        let old_epoch = relay.epoch();
        relay.hold();
        assert!(relay.output(b"bc".to_vec()));
        assert!(relay.event(SessionEvent::State { state: SessionState::Connected, hop: None }));
        assert_eq!(seen(&old), ["a"], "nothing reaches the old window once held");
        relay.switch(new.clone());
        assert_eq!(seen(&new), ["bc", "event"]);
        // Only what the new window received is outstanding; a late ack from the old one is void.
        assert_eq!(relay.unacked(), 2);
        relay.ack(old_epoch, 2);
        assert_eq!(relay.unacked(), 2);
        relay.ack(relay.epoch(), 2);
        assert_eq!(relay.unacked(), 0);
        assert!(relay.output(b"d".to_vec()));
        assert_eq!(seen(&new), ["bc", "event", "d"]);
        assert_eq!(seen(&old), ["a"]);
    }

    #[test]
    fn a_lapsed_offer_releases_to_the_owner_and_held_events_are_bounded() {
        let old = Arc::new(Recorder::default());
        let relay = Relay::new(old.clone());
        relay.hold();
        assert!(relay.output(b"x".to_vec()));
        relay.release();
        assert_eq!(seen(&old), ["x"]);
        assert_eq!(relay.unacked(), 1, "the owner still has to acknowledge it");
        relay.hold();
        for _ in 0..MAX_HELD_EVENTS {
            assert!(relay.event(SessionEvent::State { state: SessionState::Connected, hop: None }));
        }
        assert!(!relay.event(SessionEvent::State { state: SessionState::Connected, hop: None }));
    }
}
