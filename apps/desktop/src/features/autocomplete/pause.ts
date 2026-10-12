// Pausing suggestions (AUT-12): for one session until it closes, or everywhere until a time.
// In memory only, so a restart always starts with suggestions available again.

const pausedSessions = new Set<string>();
let pausedUntil = 0;

export const pause = {
  session(sessionId: string) {
    pausedSessions.add(sessionId);
  },
  /** Pauses every session for `minutes`. */
  all(minutes: number, now = Date.now()) {
    pausedUntil = now + minutes * 60_000;
  },
  resume(sessionId: string | null) {
    if (sessionId) pausedSessions.delete(sessionId);
    pausedUntil = 0;
  },
  /** Why suggestions are paused for this session, if they are. */
  state(sessionId: string, now = Date.now()): "session" | "all" | null {
    if (pausedSessions.has(sessionId)) return "session";
    if (pausedUntil > now) return "all";
    return null;
  },
};
