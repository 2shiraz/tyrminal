// Afterglow's host details (experimental UI, branch only; plan §6 moment 4, "sheet physics"):
// main's HostPanel, unchanged, which you can also throw away by its header. Swapped in for
// features/hosts/HostPanel.tsx by vite.exp.mjs; same exports and props.
//
// - The panel tracks the pointer 1:1 from where it was grabbed (pointer capture), to the right.
//   Dragged left, past its resting place, it rubber-bands (constant 0.55).
// - On release it is thrown away when the flick is fast enough (0.11 px/ms, Emil's threshold) or
//   when Apple's momentum projection lands past half its width; otherwise it springs home. Either
//   spring starts with the release velocity, so there is no seam.
// - Thrown away, it asks to close through the panel's own close request (so main's unsaved-change
//   guard still applies); if it stays, it springs back.
// - Esc and the close button behave as on main. Buttons in the header are never a drag handle.
//   Under reduced motion the drag still follows the pointer and the release simply lands.
import { type ComponentProps, type RefObject, useEffect, useRef } from "react";

import { HostPanel as MainHostPanel } from "../../features/hosts/HostPanel";
import { project, rubberband, springX } from "../motion/spring";

export type { PanelTarget } from "../../features/hosts/HostPanel";

const FLICK = 0.11; // px/ms

function useThrowAway(host: RefObject<HTMLDivElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let drag: { id: number; startX: number; offset: number; width: number; samples: { t: number; x: number }[]; panel: HTMLElement } | null = null;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      const target = event.target as Element;
      const head = target.closest(".host-panel-head");
      if (!head || target.closest("button, input, select, textarea, a, [role='menu']")) return;
      const panel = head.closest<HTMLElement>(".host-panel");
      if (!panel) return;
      for (const a of panel.getAnimations()) a.cancel();
      const current = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41;
      drag = { id: event.pointerId, startX: event.clientX - current, offset: current, width: panel.offsetWidth, samples: [{ t: event.timeStamp, x: current }], panel };
      try {
        panel.setPointerCapture(event.pointerId);
      } catch {
        // Not a pointer the browser tracks (a synthetic event): the drag works without capture.
      }
      panel.dataset.dragging = "";
    };

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const raw = event.clientX - drag.startX;
      drag.offset = raw >= 0 ? raw : rubberband(raw, drag.width);
      drag.panel.style.transform = `translateX(${drag.offset}px)`;
      // Every position the pointer passed through, not just the frame-aligned one, for velocity.
      for (const e of event.getCoalescedEvents?.() ?? [event]) {
        const r = e.clientX - drag.startX;
        drag.samples.push({ t: e.timeStamp, x: r >= 0 ? r : rubberband(r, drag.width) });
      }
      if (drag.samples.length > 32) drag.samples.splice(0, drag.samples.length - 32);
    };

    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { panel, offset, width, samples } = drag;
      drag = null;
      delete panel.dataset.dragging;
      if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
      // Velocity over the last 80 ms, counting the stillness before release: a pointer that
      // stopped and then let go carries no velocity, however fast it moved earlier.
      samples.push({ t: event.timeStamp, x: offset });
      const recent = samples.filter((s) => event.timeStamp - s.t <= 80);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const velocity = first && last && recent.length > 1 && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      if (offset <= 0 && velocity <= 0) {
        void springX(panel, "sheet", offset, 0, velocity);
        return;
      }
      const away = velocity >= FLICK || offset + project(velocity) > width / 2;
      if (!away) {
        void springX(panel, velocity > 0.05 ? "sheetFlick" : "sheet", offset, 0, velocity);
        return;
      }
      void springX(panel, "sheetExit", offset, width, Math.max(velocity, 0)).then(() => {
        closeRef.current();
        // Still here (the close was refused, or is waiting on a question): come back.
        requestAnimationFrame(() => {
          if (panel.isConnected) void springX(panel, "sheet", width, 0);
        });
      });
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
    };
  }, [host]);
}

export function HostPanel(props: ComponentProps<typeof MainHostPanel>) {
  const host = useRef<HTMLDivElement>(null);
  useThrowAway(host, props.onRequestClose);
  return (
    <div ref={host} className="ag-sheet">
      <MainHostPanel {...props} />
    </div>
  );
}
