import { useEffect, useState } from "react";

/** The longest wait for a frame: a hidden or minimized window may not draw any. */
const FRAME_FALLBACK_MS = 100;

/**
 * False until `ready` is true and the frame showing it has been painted, then true for good. Loads
 * that the first screen does not show start from here, so they do not compete with it for the
 * vault (which serves one call at a time) or the main thread.
 */
export function useAfterFirstPaint(ready: boolean): boolean {
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (!ready || painted) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setPainted(true);
    };
    // A message posted from an animation frame callback runs after that frame painted.
    const channel = new MessageChannel();
    channel.port1.onmessage = finish;
    const frame = requestAnimationFrame(() => channel.port2.postMessage(null));
    const timer = window.setTimeout(finish, FRAME_FALLBACK_MS);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      channel.port1.close();
    };
  }, [ready, painted]);
  return painted;
}
