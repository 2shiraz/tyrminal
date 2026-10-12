// A tiny list windowing hook (docs/design/interaction-polish.md, section 1, "Large lists"): above
// WINDOW_THRESHOLD items only the rows near the visible part of the scroll container are in the
// DOM, with the list's padding (or, for a table body, two spacer rows) holding the height of the
// rest. Works for one-column lists, table bodies and CSS grids of cards (it measures the columns and
// the row pitch from the rendered items). Below the threshold every item renders, exactly as before.
// No dependency: a few dozen lines are enough for rows of one height, and they keep the list's own
// markup, roles and keyboard handling.
//
// Usage (FileTable shows a table body with spacer rows instead of padding):
//
//   const win = useWindowedList<HTMLUListElement>(items.length, 56); // rows about 56 px tall
//   <ul ref={win.ref} style={win.style}>
//     {items.slice(win.start, win.end).map((item, i) => (
//       <li key={item.id} data-window-item
//           {...(win.windowed ? { "aria-setsize": items.length, "aria-posinset": win.start + i + 1 } : {})}>
//
// The items must be the list's direct children and carry `data-window-item`. For the keyboard,
// call `win.scrollToIndex(index)` before focusing an item that may not be rendered, and focus it in
// requestAnimationFrame (after React has drawn the new window). Rows are taken to be as tall as the
// tallest one seen so far; in a CSS grid `style` sets `gridAutoRows` so every row really is.
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

/** Lists longer than this are windowed. */
export const WINDOW_THRESHOLD = 200;
/** Lines rendered above and below the visible part, so Tab and arrow keys always find a neighbour. */
const OVERSCAN_LINES = 8;

export interface ListWindow<E extends HTMLElement> {
  /** Attach to the list element; its windowed items carry `data-window-item`. */
  ref: RefObject<E | null>;
  windowed: boolean;
  /** Items to render: [start, end). */
  start: number;
  end: number;
  /** Space held before and after the rendered items (the list's padding, or spacer rows in a table). */
  before: number;
  after: number;
  /** That padding and, in a CSS grid, the row height, ready for the list's `style` (empty when not windowed). */
  style: { paddingTop?: number; paddingBottom?: number; gridAutoRows?: string };
  /** Brings item `index` into view (and into the DOM) before the next paint. */
  scrollToIndex: (index: number) => void;
}

interface Metrics {
  /** Measured from rendered items; until then `pitch` is the estimate. */
  measured: boolean;
  pitch: number;
  columns: number;
  gap: number;
}

/** What is rendered: lines [first, last) laid out with these metrics. */
interface Range {
  first: number;
  last: number;
  pitch: number;
  columns: number;
  gap: number;
  measured: boolean;
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let el = element.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function viewport(scroller: HTMLElement): { top: number; height: number } {
  if (scroller === document.scrollingElement || scroller === document.documentElement) return { top: 0, height: window.innerHeight };
  return { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight };
}

/**
 * Windows `count` items whose rows are about `estimate` pixels tall. `external` is the list element's
 * ref when the list already has one (say, for animations); otherwise the hook makes its own.
 */
export function useWindowedList<E extends HTMLElement>(
  count: number,
  estimate = 56,
  external?: RefObject<E | null>,
  threshold = WINDOW_THRESHOLD,
): ListWindow<E> {
  const own = useRef<E | null>(null);
  const ref = external ?? own;
  const windowed = count > threshold;
  const metrics = useRef<Metrics>({ measured: false, pitch: estimate, columns: 1, gap: 0 });
  const initialLines = Math.ceil((typeof window === "undefined" ? 900 : window.innerHeight) / estimate) + OVERSCAN_LINES;
  const [range, setRange] = useState<Range>({ first: 0, last: initialLines, pitch: estimate, columns: 1, gap: 0, measured: false });

  const measure = useCallback(() => {
    const list = ref.current;
    if (!list) return;
    const items = list.querySelectorAll<HTMLElement>(":scope > [data-window-item]");
    const first = items[0];
    if (!first) return;
    const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    let columns = 1;
    while (columns < items.length && items[columns]?.offsetTop === first.offsetTop) columns += 1;
    const nextLine = items[columns];
    let pitch = nextLine ? nextLine.offsetTop - first.offsetTop : first.offsetHeight + gap;
    for (const item of items) pitch = Math.max(pitch, Math.max(item.offsetHeight, item.scrollHeight) + gap);
    // The pitch only grows: a window of shorter rows must not shrink it and move the window back to
    // where taller rows were (that would never settle).
    if (metrics.current.measured) pitch = Math.max(pitch, metrics.current.pitch);
    if (pitch > 0) metrics.current = { measured: true, pitch, columns, gap };
  }, [ref]);

  const compute = useCallback(() => {
    const list = ref.current;
    if (!list || count <= threshold) return;
    const { measured, pitch, columns, gap } = metrics.current;
    const view = viewport(scrollParent(list));
    const from = view.top - list.getBoundingClientRect().top;
    const total = Math.ceil(count / columns);
    const first = Math.max(0, Math.min(total, Math.floor(from / pitch) - OVERSCAN_LINES));
    const last = Math.max(first, Math.min(total, Math.ceil((from + view.height) / pitch) + OVERSCAN_LINES));
    setRange((current) =>
      current.first === first && current.last === last && current.pitch === pitch && current.columns === columns && current.gap === gap && current.measured === measured
        ? current
        : { first, last, pitch, columns, gap, measured },
    );
  }, [ref, count, threshold]);

  /** Scrolls so that item `index` is in view, by the pitch known now. */
  const reveal = useCallback(
    (index: number) => {
      const list = ref.current;
      if (!list) return;
      const { pitch, columns } = metrics.current;
      const scroller = scrollParent(list);
      const view = viewport(scroller);
      const listTop = list.getBoundingClientRect().top - view.top;
      const itemTop = listTop + Math.floor(index / columns) * pitch;
      const isPage = scroller === document.scrollingElement || scroller === document.documentElement;
      const scrollBy = (delta: number) => (isPage ? window.scrollBy(0, delta) : (scroller.scrollTop += delta));
      if (itemTop < 0) scrollBy(itemTop);
      else if (itemTop + pitch > view.height) scrollBy(itemTop + pitch - view.height);
    },
    [ref],
  );

  // An item asked for by scrollToIndex, until it is rendered: rows measured on the way can be taller
  // than the pitch it was scrolled by, so it is scrolled to again with the new one.
  const pending = useRef<{ index: number; tries: number } | null>(null);

  // Measure what rendered, then settle the range before the browser paints.
  useLayoutEffect(() => {
    if (!windowed) {
      pending.current = null;
      return;
    }
    measure();
    const target = pending.current;
    if (target) {
      const { columns } = metrics.current;
      const rendered = target.index >= range.first * columns && target.index < range.last * columns;
      if ((rendered && range.pitch === metrics.current.pitch) || target.tries >= 4) pending.current = null;
      else {
        target.tries += 1;
        reveal(target.index);
      }
    }
    compute();
  });

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || !windowed) return;
    const scroller = scrollParent(list);
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        compute();
      });
    };
    const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    target.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    observer?.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, [ref, windowed, measure, compute]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const list = ref.current;
      if (!list || count <= threshold || index < 0) return;
      measure();
      pending.current = { index, tries: 0 };
      reveal(index);
      compute();
    },
    [ref, count, threshold, measure, reveal, compute],
  );

  if (!windowed) return { ref, windowed, start: 0, end: count, before: 0, after: 0, style: {}, scrollToIndex };
  const { pitch, columns, gap, measured } = range;
  const total = Math.ceil(count / columns);
  const first = Math.min(range.first, total);
  const last = Math.min(Math.max(range.last, first), total);
  return {
    ref,
    windowed,
    start: first * columns,
    end: Math.min(count, last * columns),
    before: first * pitch,
    after: (total - last) * pitch,
    style: {
      paddingTop: first * pitch,
      paddingBottom: (total - last) * pitch,
      ...(measured && columns > 1 ? { gridAutoRows: `${pitch - gap}px` } : {}),
    },
    scrollToIndex,
  };
}
