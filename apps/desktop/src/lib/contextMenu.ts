/**
 * The WebView's own context menu (Reload, Inspect Element, Back) is never shown. App surfaces
 * that have a menu open their own (React `onContextMenu`, the terminal's right-click paste) and
 * call `preventDefault` themselves; this listener runs after them, on the window in the bubble
 * phase, and blocks whatever is left. Text fields keep the system menu (Cut, Copy, Paste, spelling).
 */
export function suppressWebviewContextMenu(target: Window = window): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (isTextField(event.target)) return;
    event.preventDefault();
  };
  target.addEventListener("contextmenu", onContextMenu);
  return () => target.removeEventListener("contextmenu", onContextMenu);
}

function isTextField(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  // xterm moves its hidden input under the pointer on right-click; that is the terminal, not a field.
  if (node.classList.contains("xterm-helper-textarea")) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
  if (node instanceof HTMLInputElement) {
    const textual = ["text", "search", "url", "email", "tel", "number", "password", ""];
    return textual.includes(node.type) && !node.readOnly && !node.disabled;
  }
  return false;
}
