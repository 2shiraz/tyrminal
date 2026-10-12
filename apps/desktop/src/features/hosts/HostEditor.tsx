import type { GroupSummary, HostSummary, KeySummary } from "@tyrminal/contracts";
import type { FormEvent } from "react";

import { Dialog } from "../../components/ui/Dialog";
import { ErrorNotice } from "../../components/ui/controls";
import { IconServer } from "../../components/ui/icons";
import { msg } from "../../lib/messages";
import { HostFormCards, type HostFormOptions, useHostForm } from "./hostForm";

export { groupDefaults, groupPath } from "./hostForm";

/**
 * The host form in a dialog, for saving a host from outside the Hosts view (quick connect on
 * Home). The Hosts view edits hosts in its side panel (HostPanel.tsx) with the same cards.
 */
export function HostEditor({
  onClose,
  onSaved,
  ...options
}: HostFormOptions & {
  keys: KeySummary[];
  groups?: GroupSummary[];
  onClose: () => void;
  onSaved: (saved: HostSummary) => void;
}) {
  const form = useHostForm(options);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await form.save();
    if (saved) onSaved(saved);
  }

  return (
    <Dialog title={options.host ? msg.hosts.editorEdit : msg.hosts.editorNew} icon={<IconServer size={18} />} onDismiss={onClose}>
      <form className="stack host-form" onSubmit={submit} aria-busy={form.pending}>
        <HostFormCards form={form} autoFocus />
        <ErrorNotice error={form.error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {msg.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!form.ready || form.pending}>
            {form.pending ? msg.common.working : msg.common.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
