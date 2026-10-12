import { useEffect, useState } from "react";

import { msg } from "../../lib/messages";

/** True while this window has focus, the way a terminal knows whether to draw a solid cursor. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

/**
 * The Tyrminal wordmark: a prompt and a block cursor, then the name. The cursor is solid while
 * the window has focus and hollow when it does not. It never blinks.
 */
export function Wordmark({ name = true }: { name?: boolean }) {
  const focused = useWindowFocused();
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true">
        &gt;
        <span className="cursor-block" data-hollow={!focused} />
      </span>
      {name && <span className="wordmark-name">{msg.app.name}</span>}
    </span>
  );
}
