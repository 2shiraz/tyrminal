// Protocol choice for a host (HST-01): SSH, Telnet or a serial device on this computer.
import type {
  HostProtocol,
  HostTerminal,
  SerialFlowControl,
  SerialParity,
  SerialSettings,
  TerminalEncoding,
  TerminalType,
} from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { Notice, Switch, TextField } from "../../components/ui/controls";
import { preferences as preferencesApi } from "../../lib/ipc";
import { msg } from "../../lib/messages";

export type ProtocolKind = HostProtocol["type"];

export const DEFAULT_SERIAL: SerialSettings = { path: "", baud: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" };

const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function ProtocolSelect({ value, onChange }: { value: ProtocolKind; onChange: (kind: ProtocolKind) => void }) {
  return (
    <label className="field">
      <span className="label">{msg.hosts.protocol}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value as ProtocolKind)}>
        <option value="ssh">SSH</option>
        <option value="telnet">{msg.hosts.telnet}</option>
        <option value="serial">{msg.hosts.serial}</option>
      </select>
    </label>
  );
}

export function TelnetWarning() {
  return <Notice tone="warning">{msg.hosts.telnetWarning}</Notice>;
}

/** Device and line settings of a serial host. */
export function SerialFields({ value, onChange }: { value: SerialSettings; onChange: (next: SerialSettings) => void }) {
  const [ports, setPorts] = useState<string[] | null>(null);
  useEffect(() => {
    preferencesApi
      .serialPorts()
      .then(setPorts)
      .catch(() => setPorts([]));
  }, []);
  const set = (patch: Partial<SerialSettings>) => onChange({ ...value, ...patch });
  const listId = "serial-ports";
  return (
    <div className="stack-sm">
      <TextField
        label={msg.hosts.serialPort}
        value={value.path}
        onChange={(path) => set({ path })}
        list={listId}
        maxLength={256}
        hint={ports && ports.length === 0 ? msg.hosts.serialNone : msg.hosts.serialHint}
      />
      <datalist id={listId}>
        {(ports ?? []).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="split">
        <label className="field">
          <span className="label">{msg.hosts.serialBaud}</span>
          <select className="select" value={value.baud} onChange={(e) => set({ baud: Number(e.target.value) })}>
            {BAUDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">{msg.hosts.serialDataBits}</span>
          <select className="select" value={value.dataBits} onChange={(e) => set({ dataBits: Number(e.target.value) })}>
            {[8, 7, 6, 5].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="split">
        <label className="field">
          <span className="label">{msg.hosts.serialParity}</span>
          <select className="select" value={value.parity} onChange={(e) => set({ parity: e.target.value as SerialParity })}>
            <option value="none">{msg.hosts.none}</option>
            <option value="odd">{msg.hosts.odd}</option>
            <option value="even">{msg.hosts.even}</option>
          </select>
        </label>
        <label className="field">
          <span className="label">{msg.hosts.serialStopBits}</span>
          <select className="select" value={value.stopBits} onChange={(e) => set({ stopBits: Number(e.target.value) })}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label className="field">
          <span className="label">{msg.hosts.serialFlow}</span>
          <select className="select" value={value.flowControl} onChange={(e) => set({ flowControl: e.target.value as SerialFlowControl })}>
            <option value="none">{msg.hosts.none}</option>
            <option value="software">XON/XOFF</option>
            <option value="hardware">RTS/CTS</option>
          </select>
        </label>
      </div>
    </div>
  );
}

const ENCODINGS: [TerminalEncoding, string][] = [
  ["utf8", "UTF-8"],
  ["iso8859-1", "ISO-8859-1 (Western)"],
  ["iso8859-15", "ISO-8859-15 (Western, €)"],
  ["windows1252", "Windows-1252"],
  ["koi8-r", "KOI8-R (Cyrillic)"],
  ["shift-jis", "Shift_JIS (Japanese)"],
  ["euc-jp", "EUC-JP (Japanese)"],
  ["euc-kr", "EUC-KR (Korean)"],
  ["gbk", "GBK (Simplified Chinese)"],
  ["gb18030", "GB18030 (Chinese)"],
  ["big5", "Big5 (Traditional Chinese)"],
];

const TERMS: [TerminalType, string][] = [
  ["xterm256color", "xterm-256color"],
  ["xterm", "xterm"],
  ["linux", "linux"],
  ["vt220", "vt220"],
  ["vt100", "vt100"],
];

export const DEFAULT_TERMINAL: HostTerminal = { encoding: "utf8", term: "xterm256color" };

/** Character encoding and terminal type (TRM-05, TRM-06); serial lines report no type. */
export function TerminalFields({ value, onChange, showTerm }: { value: HostTerminal; onChange: (next: HostTerminal) => void; showTerm: boolean }) {
  return (
    <div className="split">
      <label className="field">
        <span className="label">{msg.hosts.encoding}</span>
        <select className="select" value={value.encoding} onChange={(e) => onChange({ ...value, encoding: e.target.value as TerminalEncoding })}>
          {ENCODINGS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {showTerm && (
        <label className="field">
          <span className="label">{msg.hosts.terminalType}</span>
          <select className="select" value={value.term} onChange={(e) => onChange({ ...value, term: e.target.value as TerminalType })}>
            {TERMS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Agent forwarding (CON-11): off by default; only this host's sign-in key is offered. */
export function AgentForwarding({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="stack-sm">
      <Switch label={msg.hosts.forwardAgent} checked={checked} onChange={onChange} />
      {checked && <Notice tone="warning">{msg.hosts.forwardAgentWarning}</Notice>}
    </div>
  );
}
