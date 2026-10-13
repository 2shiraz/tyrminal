import { type ReactNode, useEffect, useRef, useState } from "react";

import { IconChevronDown } from "./icons";

/**
 * A primary action with a small arrow beside it for its other forms (for example "… and don't ask
 * again"). The menu is drawn inside the button's own container rather than at the document root,
 * so it also works inside a modal dialog.
 */
export function SplitAction({
  children,
  onClick,
  disabled = false,
  autoFocus = false,
  moreLabel,
  items,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Accessible name of the arrow and of its menu. */
  moreLabel: string;
  items: { label: string; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  return (
    <span className="split-action" ref={root}>
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={onClick} data-autofocus={autoFocus || undefined}>
        {children}
      </button>
      <button
        ref={more}
        type="button"
        className="btn btn-primary split-action-more"
        disabled={disabled}
        aria-label={moreLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div
          className="menu split-action-menu"
          role="menu"
          aria-label={moreLabel}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Close only this menu: the dialog it sits in stays open.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            more.current?.focus();
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              autoFocus={index === 0}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
