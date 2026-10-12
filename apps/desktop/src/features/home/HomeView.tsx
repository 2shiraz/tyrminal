import type { HostSummary, SnippetSummary } from "@tyrminal/contracts";
import { useState } from "react";

import type { Destination } from "../../app/AppShell";
import { useVaultData } from "../../app/vaultData";
import type { Workspace } from "../../app/workspace";
import { useToast } from "../../components/ui/Toasts";
import { SkeletonRows } from "../../components/ui/controls";
import { IconArrowLeftRight, IconFolderOpen, IconKeyRound, IconPlus, IconSquareTerminal } from "../../components/ui/icons";
import { vault } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { GenerateKeyDialog } from "../credentials/KeychainView";
import { HostEditor } from "../hosts/HostEditor";
import { ImportDialog } from "../hosts/ImportDialog";
import { msgD } from "../../lib/messages-d";
import type { Section as SettingsSection } from "../settings/SettingsViews";
import { msgSftp } from "../sftp/messages";
import { MultiRunDialog } from "../snippets/MultiRunDialog";
import type { PaneStatus } from "../terminal/TerminalView";
import { FavouritesBox, ForwardsBox, GetStartedBox, HostsBox, ReviewBox, SessionsBox, SnippetsBox, VaultBox } from "./HomeBoxes";
import { QuickConnect } from "./QuickConnect";

export { parseDestination } from "./QuickConnect";

/**
 * Home (docs/design/revamp.md §5): quick connect, a strip of things to start, then boxes with the
 * user's own state: open sessions, hosts most recently used first and snippets on the left; the vault,
 * the security review and port forwards on the right. Nothing animates in.
 */
export function HomeView({
  ws,
  statuses,
  onConnect,
  onConnectSplit,
  onSftpHost,
  onLocal,
  onSftp,
  onNavigate,
  onSelectTab,
  onOpenSettings,
}: {
  ws: Workspace;
  statuses: Record<number, PaneStatus>;
  onConnect: (host: HostSummary) => void;
  /** Cmd/Ctrl+Enter on a host row. */
  onConnectSplit?: (host: HostSummary) => void;
  /** Shift+Enter on a host row (SSH hosts). */
  onSftpHost?: (host: HostSummary) => void;
  onLocal: () => void;
  /** Opens a new SFTP tab. */
  onSftp?: () => void;
  onNavigate: (d: Destination) => void;
  onSelectTab: (id: number) => void;
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const { hosts, keys, groups } = useVaultData();
  const notify = useToast();
  const [dialog, setDialog] = useState<"host" | "import" | "key" | null>(null);
  const [prefill, setPrefill] = useState<{ username: string; address: string; port: number } | null>(null);
  const [running, setRunning] = useState<SnippetSummary | null>(null);
  const all = hosts.value ?? [];
  const loading = hosts.value === null && !hosts.error;
  const canRun = Object.values(ws.panes).some((pane) => statuses[pane.id]?.state === "connected");
  const lock = () => void vault.lock().catch(() => undefined);

  const startRows = [
    { key: "host", title: msg.home.start.addHost.title, body: msg.home.start.addHost.body, icon: <IconPlus size={15} />, onClick: () => setDialog("host") },
    { key: "import", title: msg.home.start.import.title, body: msg.home.start.import.body, icon: <IconFolderOpen size={15} />, onClick: () => setDialog("import") },
    { key: "key", title: msg.home.start.generateKey.title, body: msg.home.start.generateKey.body, icon: <IconKeyRound size={15} />, onClick: () => setDialog("key") },
    { key: "local", title: msg.home.start.local.title, body: msg.home.start.local.body, icon: <IconSquareTerminal size={15} />, onClick: onLocal },
  ];

  return (
    <div className="page">
      <div className="page-inner home">
        <div className="page-header">
          <div className="page-title">
            <h1>{all.length === 0 && !loading ? msg.home.welcomeTitle : msg.home.title}</h1>
            {all.length === 0 && !loading && <p>{msg.home.welcomeBody}</p>}
          </div>
        </div>

        <QuickConnect
          onConnect={onConnect}
          onSaveFailed={(parsed) => {
            setPrefill(parsed);
            setDialog("host");
          }}
        />

        <div className="home-actions">
          <div className="btn-strip" role="group" aria-label={msg.home.actionsLabel}>
            <button type="button" className="btn" onClick={() => setDialog("host")}>
              <IconPlus size={15} />
              {msg.hosts.add}
            </button>
            <button type="button" className="btn" onClick={() => setDialog("import")}>
              <IconFolderOpen size={15} />
              {msg.home.importHosts}
            </button>
            <button type="button" className="btn" onClick={onLocal}>
              <IconSquareTerminal size={15} />
              {msg.nav.localTerminal}
            </button>
            {onSftp && (
              <button type="button" className="btn" onClick={onSftp}>
                <IconArrowLeftRight size={15} />
                {msgSftp.open}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setDialog("key")}>
              <IconKeyRound size={15} />
              {msg.home.generateKey}
            </button>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenSettings("shortcuts")}>
            {msg.home.shortcuts}
          </button>
        </div>

        {loading ? (
          <SkeletonRows count={3} height={36} />
        ) : all.length === 0 ? (
          <div className="home-first">
            {ws.tabs.length > 0 && <SessionsBox ws={ws} statuses={statuses} onSelectTab={onSelectTab} onNewTab={onLocal} />}
            <GetStartedBox rows={startRows} />
          </div>
        ) : (
          <div className="home-grid">
            <div className="box-grid home-column">
              {ws.tabs.length > 0 && <SessionsBox ws={ws} statuses={statuses} onSelectTab={onSelectTab} onNewTab={onLocal} />}
              <FavouritesBox onConnect={onConnect} onConnectSplit={onConnectSplit} onSftpHost={onSftpHost} />
              <HostsBox onConnect={onConnect} onConnectSplit={onConnectSplit} onSftpHost={onSftpHost} onAllHosts={() => onNavigate("hosts")} />
              <SnippetsBox canRun={canRun} onRun={setRunning} onLibrary={() => onNavigate("snippets")} />
            </div>
            <div className="box-grid home-column">
              <VaultBox onLock={lock} />
              <ReviewBox onOpen={() => onOpenSettings("review")} />
              <ForwardsBox onTunnels={() => onNavigate("tunnels")} />
            </div>
          </div>
        )}
      </div>

      {dialog === "host" && (
        <HostEditor
          host={null}
          initial={prefill ?? undefined}
          keys={keys.value ?? []}
          onClose={() => {
            setDialog(null);
            setPrefill(null);
          }}
          onSaved={() => {
            setDialog(null);
            setPrefill(null);
            void hosts.reload();
          }}
        />
      )}
      {dialog === "import" && (
        <ImportDialog
          groups={groups.value ?? []}
          intoGroup={null}
          onClose={() => setDialog(null)}
          onImported={(count) => {
            setDialog(null);
            notify("success", msg.hosts.importDone(count));
            void hosts.reload();
          }}
          onTrusted={(count) => {
            setDialog(null);
            notify("success", msgD.import.trustDone(count));
          }}
        />
      )}
      {dialog === "key" && (
        <GenerateKeyDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void keys.reload();
          }}
        />
      )}
      {running && <MultiRunDialog snippet={running} onClose={() => setRunning(null)} />}
    </div>
  );
}
