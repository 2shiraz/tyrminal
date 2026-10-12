import { Menu, type MenuEntry } from "../../components/ui/Menu";
import { useToast } from "../../components/ui/Toasts";
import { IconCopy, IconServer } from "../../components/ui/icons";
import { msgI } from "../../lib/messages-input";
import { requestNewHost } from "./requests";
import { type Token, addressAndPort } from "./tokenLinks";

/** The menu for a clicked token: copy it, or (addresses) start a new saved host for it. */
export function TokenMenu({ token, onClose }: { token: Token; onClose: () => void }) {
  const notify = useToast();
  const copy = () =>
    void navigator.clipboard.writeText(token.text).then(
      () => notify("success", msgI.tokens.copied(token.text)),
      () => notify("danger", msgI.tokens.copyFailed),
    );
  const items: MenuEntry[] = [{ label: token.kind === "path" ? msgI.tokens.copyPath : msgI.tokens.copy, icon: <IconCopy size={15} />, onSelect: copy }];
  if (token.kind === "address") {
    const target = addressAndPort(token.text);
    items.push({ label: msgI.tokens.newHost(target.address), icon: <IconServer size={15} />, onSelect: () => requestNewHost(target) });
  }
  return <Menu label={msgI.tokens.menu(token.text)} point={{ x: token.x, y: token.y }} items={items} onClose={onClose} />;
}
