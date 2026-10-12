import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { IconCheck } from "./icons";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: ReactNode;
  tone?: "danger";
  disabled?: boolean;
  /** A setting the item turns on and off: shown with a check, announced as a checkbox. */
  checked?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | "separator";

/**
 * Popup menu anchored to an element or a point. Arrow keys move, Enter/Space choose, Escape or a
 * click outside closes; focus returns to the opener.
 */
export function Menu({
  anchor,
  point,
  items,
  label,
  onClose,
}: {
  anchor?: HTMLElement | null | undefined;
  point?: { x: number; y: number } | undefined;
  items: MenuEntry[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  // What had focus before the menu took it (read while rendering, before the menu focuses itself).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    let left = point?.x ?? 0;
    let top = point?.y ?? 0;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = r.right - width;
      top = r.bottom + 4;
      if (left < 8) left = r.left;
    }
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) top = Math.max(8, (anchor ? anchor.getBoundingClientRect().top : top) - height - 4);
    setPosition({ left, top });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor, point]);

  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      // Back to whatever had focus (a row, for a menu opened from the keyboard), else the anchor.
      (opener?.isConnected && opener !== document.body ? opener : anchor)?.focus?.();
    };
  }, [anchor, opener, onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? buttons[0] : buttons.at(-1))?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  return createPortal(
    <div ref={ref} className="menu" role="menu" aria-label={label} style={position} onKeyDown={onKeyDown}>
      {items.map((item, index) =>
        item === "separator" ? (
          // Separators are positional.
          <div key={`sep-${index}`} className="menu-sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            className="menu-item"
            data-tone={item.tone}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.checked === undefined ? item.icon : <span className="menu-check" aria-hidden="true">{item.checked && <IconCheck size={14} />}</span>}
            <span>{item.label}</span>
            {item.shortcut}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
