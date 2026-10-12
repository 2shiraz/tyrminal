import { useEffect, useState } from "react";

/**
 * A wait shorter than this shows nothing: fast loads never flash a skeleton or progress bar
 * (docs/design/interaction-polish.md, section 1).
 */
export const LOADING_DELAY_MS = 150;

/** True once `active` has stayed true for `delay` ms; false again as soon as it is false. */
export function useDelayed(active: boolean, delay = LOADING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return active && shown;
}
