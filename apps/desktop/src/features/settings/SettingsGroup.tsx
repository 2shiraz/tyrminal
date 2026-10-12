import type { ReactNode } from "react";

import { Box } from "../../components/ui/Box";

/** A group of settings inside a section: a box whose strip names the group, above its rows. */
export function SettingsGroup({
  title,
  hint,
  actions,
  className = "",
  children,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Box title={title} actions={actions} headingLevel={3} className={`settings-group ${className}`.trim()}>
      {hint && <p className="settings-group-hint">{hint}</p>}
      <div className="settings-group-rows">{children}</div>
    </Box>
  );
}
