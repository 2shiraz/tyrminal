// Which input the user is on, for motion: motion answers the
// pointer and never the keyboard. Also warms tooltips: once one has shown, the next open at once.

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
const TIP_DELAY_MS = 450;
const TIP_COOL_MS = 600;

/** How the surface being opened now was asked for: the last input before it. */
export function openedBy(): "pointer" | "keyboard" {
  return document.documentElement.dataset.input === "pointer" ? "pointer" : "keyboard";
}

/**
 * A motion token in milliseconds as the document resolves it now (0 under reduced motion). Units
 * are read, since the build may write `180ms` as `.18s`.
 */
export function motionMs(token: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return 0;
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : value;
}

/** Installs the document listeners once, before the first render. */
export function installInputModality(root: Document = document): () => void {
  const html = root.documentElement;
  const onPointerDown = () => {
    html.dataset.input = "pointer";
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!MODIFIERS.has(event.key)) html.dataset.input = "keyboard";
  };

  let warmTimer = 0;
  let coolTimer = 0;
  const onPointerOver = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest("button[data-tooltip]")) return;
    window.clearTimeout(coolTimer);
    if (html.dataset.tipsWarm !== undefined) return;
    window.clearTimeout(warmTimer);
    warmTimer = window.setTimeout(() => {
      html.dataset.tipsWarm = "";
    }, TIP_DELAY_MS);
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest("button[data-tooltip]")) return;
    window.clearTimeout(warmTimer);
    window.clearTimeout(coolTimer);
    coolTimer = window.setTimeout(() => {
      delete html.dataset.tipsWarm;
    }, TIP_COOL_MS);
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("pointerover", onPointerOver, true);
  root.addEventListener("pointerout", onPointerOut, true);
  return () => {
    window.clearTimeout(warmTimer);
    window.clearTimeout(coolTimer);
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("pointerover", onPointerOver, true);
    root.removeEventListener("pointerout", onPointerOut, true);
  };
}
