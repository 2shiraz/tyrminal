import { useEffect } from "react";

import { useToast } from "../../components/ui/Toasts";
import { msgI } from "../../lib/messages-input";
import { onSlowPattern } from "./runner";

/** Tells the user once when a highlight pattern is switched off for taking too long. */
export function useSlowPatternNotice(): void {
  const notify = useToast();
  useEffect(() => onSlowPattern((rule) => notify("danger", msgI.highlight.slowNotice(rule.text))), [notify]);
}
