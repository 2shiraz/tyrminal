import { type ReactNode, useId } from "react";

/**
 * A box (docs/design/revamp.md §4): a section labelled by a 32 px strip (heading, optional count,
 * actions on the right), filled with rows that touch its edges. The heading names the section, so
 * boxes stay navigable by heading.
 */
export function Box({
  title,
  count,
  actions,
  live,
  edge,
  flush,
  headingLevel = 2,
  className,
  children,
}: {
  title: string;
  /** Shown after the title in faint tabular figures; omitted when undefined. */
  count?: number | undefined;
  actions?: ReactNode;
  /** The current or live box: a 2 px accent line on the top edge. */
  live?: boolean;
  /** Attached to a window edge: no radius, no side borders. */
  edge?: boolean;
  /** Inside a .box-grid, which draws the shared rules. */
  flush?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className={className ? `box ${className}` : "box"}
      aria-labelledby={id}
      data-live={live || undefined}
      data-edge={edge || undefined}
      data-flush={flush || undefined}
    >
      <div className="box-strip">
        <Heading id={id}>{title}</Heading>
        {count !== undefined && <span className="box-count">{count}</span>}
        {actions && <div className="box-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
