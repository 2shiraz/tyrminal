// Afterglow's tab strip (experimental UI, branch only; plan §6 moment 3, "liquid tabs"): main's
// TabStrip, unchanged, plus a pill that carries the active tab's fill from the tab you leave to the
// tab you click. Swapped in for components/layout/TabStrip.tsx by vite.exp.mjs; same export and
// props.
//
// - At rest the pixels are main's own: the active tab is filled and nothing else is drawn. During a
//   pointer switch the new tab's fill waits and the pill glides, landing exactly on it, then goes.
// - The glide shares main's tab width glide (duration and easing), and follows the new tab's live
//   box every frame, so the pill and the widening tab land together.
// - The pill is one absolutely positioned, `contain: strict` element with no children, beside the
//   tab list (the tablist holds only tabs). Only its transform and width change, the documented
//   exception to transform-only motion: a width on a childless element reflows nothing.
// - Keyboard switches and reduced motion are instant (no pill at all).
import { type ComponentProps, type RefObject, memo, useEffect, useLayoutEffect, useRef } from "react";

import { activePane } from "../../app/workspace";
import { TabStrip as MainTabStrip } from "../../components/layout/TabStrip";
import { motionMs, openedBy } from "../../lib/inputModality";

interface Box {
  x: number;
  w: number;
}

/** cubic-bezier(0.77, 0, 0.175, 1), main's --ease-in-out, solved for y at x. */
function easeInOut(x: number): number {
  const [x1, y1, x2, y2] = [0.77, 0, 0.175, 1];
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, y1, y2);
}

function usePill(host: RefObject<HTMLDivElement | null>, active: number | null) {
  const last = useRef<Box | null>(null);
  const run = useRef<{ pill: HTMLSpanElement; frame: number; shown: Box } | null>(null);

  useLayoutEffect(() => {
    const root = host.current;
    const scroll = root?.querySelector<HTMLElement>(".tabstrip-scroll");
    const tabs = root?.querySelector<HTMLElement>(".tabstrip-tabs");
    const tab = tabs?.querySelector<HTMLElement>('.tab[aria-selected="true"]');
    if (!root || !scroll || !tabs || !tab) return;
    const boxOf = (el: HTMLElement): Box => ({ x: tabs.offsetLeft + el.offsetLeft, w: el.offsetWidth });
    const from = run.current?.shown ?? last.current;
    const ms = motionMs("--duration-glide");
    const finish = () => {
      if (!run.current) return;
      cancelAnimationFrame(run.current.frame);
      run.current.pill.remove();
      run.current = null;
      delete root.dataset.pillGliding;
    };
    if (!from || ms <= 0 || openedBy() !== "pointer" || Math.abs(from.x - boxOf(tab).x) < 1) {
      finish();
      last.current = boxOf(tab);
      return;
    }
    const pill = run.current?.pill ?? document.createElement("span");
    pill.className = "tab-pill-indicator";
    pill.setAttribute("aria-hidden", "true");
    pill.dataset.kind = tab.classList.contains("tab-page") || tab.dataset.filesOnly !== undefined ? "page" : "terminal";
    if (!pill.isConnected) scroll.prepend(pill);
    root.dataset.pillGliding = "";
    const start = performance.now();
    const step = () => {
      const target = boxOf(tab);
      const p = Math.min(1, (performance.now() - start) / ms);
      const e = easeInOut(p);
      const box = { x: from.x + (target.x - from.x) * e, w: from.w + (target.w - from.w) * e };
      pill.style.transform = `translateX(${box.x}px)`;
      pill.style.width = `${box.w}px`;
      if (run.current) run.current.shown = box;
      if (p < 1) {
        if (run.current) run.current.frame = requestAnimationFrame(step);
      } else {
        last.current = target;
        finish();
      }
    };
    if (run.current) cancelAnimationFrame(run.current.frame);
    run.current = { pill, frame: 0, shown: from };
    step();
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active tab changes
  }, [active]);

  // Remember where the active tab rests (it moves when tabs open, close or are dragged).
  useEffect(() => {
    const root = host.current;
    const tabs = root?.querySelector<HTMLElement>(".tabstrip-tabs");
    if (!root || !tabs) return;
    const remember = () => {
      if (run.current) return;
      const tab = tabs.querySelector<HTMLElement>('.tab[aria-selected="true"]');
      if (tab) last.current = { x: tabs.offsetLeft + tab.offsetLeft, w: tab.offsetWidth };
    };
    root.addEventListener("transitionend", remember);
    root.addEventListener("pointerdown", remember, true);
    const sizes = new ResizeObserver(remember);
    sizes.observe(tabs);
    return () => {
      root.removeEventListener("transitionend", remember);
      root.removeEventListener("pointerdown", remember, true);
      sizes.disconnect();
      if (run.current) {
        cancelAnimationFrame(run.current.frame);
        run.current.pill.remove();
        run.current = null;
      }
    };
  }, [host]);
}

/**
 * Marks the document while the tab in front is a new tab's start page (a pane that is not a
 * terminal yet), so its tab and the status bar keep the app's colours (exp/styles/start.css). An
 * attribute on the root costs nothing to match; a `:has()` over the panes made every style
 * recalculation in the shell slower.
 */
function useStartFront(ws: ComponentProps<typeof MainTabStrip>["ws"]) {
  const start = activePane(ws)?.target.kind === "start";
  useEffect(() => {
    const root = document.documentElement;
    if (start) root.dataset.agStartFront = "";
    else delete root.dataset.agStartFront;
  }, [start]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.agStartFront;
    },
    [],
  );
}

function AfterglowTabStrip(props: ComponentProps<typeof MainTabStrip>) {
  const host = useRef<HTMLDivElement>(null);
  usePill(host, props.ws.active);
  useStartFront(props.ws);
  return (
    <div ref={host} className="ag-tabstrip">
      <MainTabStrip {...props} />
    </div>
  );
}

export const TabStrip = memo(AfterglowTabStrip);
