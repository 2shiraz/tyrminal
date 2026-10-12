// While a panel edge is being dragged the document carries `data-resizing`; terminals do not
// refit on each pointer move then, and fit once when the drag ends (RESIZE_END).

export const RESIZE_END = "tyrminal:panel-resize-end";

export function isPanelResizing(): boolean {
  return document.documentElement.hasAttribute("data-resizing");
}

export function setPanelResizing(on: boolean): void {
  if (on) document.documentElement.setAttribute("data-resizing", "");
  else if (isPanelResizing()) {
    document.documentElement.removeAttribute("data-resizing");
    window.dispatchEvent(new Event(RESIZE_END));
  }
}

/** Calls `listener` when a panel drag has ended; returns the unsubscribe. */
export function onPanelResizeEnd(listener: () => void): () => void {
  window.addEventListener(RESIZE_END, listener);
  return () => window.removeEventListener(RESIZE_END, listener);
}

