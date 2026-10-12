import type { AppInfo } from "@tyrminal/contracts";
import { useEffect, useState } from "react";

import { IconCopy, IconExternalLink } from "../../components/ui/icons";
import { app, links } from "../../lib/ipc";
import { msg } from "../../lib/messages";
import { channelName, versionLabel, versionReport } from "../../lib/version";

/** Settings → About: which build this is, a copyable block for bug reports, and links. */
export function AboutSection() {
  const version = __APP_VERSION__;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    app.info().then(
      (value) => alive && setInfo(value),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  // Links open in the OS browser only on click, through the validated link_open command.
  const open = (url: string) => void links.open(url).catch(() => undefined);
  const value = (text: string | undefined) => text ?? msg.about.unavailable;

  return (
    <section id="settings-about" className="settings-section" aria-labelledby="settings-about-title">
      <header>
        <h2 id="settings-about-title">{msg.about.title}</h2>
        <p>{msg.about.body}</p>
      </header>
      <dl className="kv" aria-label={msg.about.title}>
        <dt>{msg.about.version}</dt>
        <dd className="mono selectable">
          {msg.app.name} {versionLabel(version)}
        </dd>
        <dt>{msg.about.channel}</dt>
        <dd>{channelName(version)}</dd>
        <dt>{msg.about.commit}</dt>
        <dd className="mono selectable">{value(info?.commit)}</dd>
        <dt>{msg.about.built}</dt>
        <dd>{info ? msg.about.builtValue(info.buildDate) : msg.about.unavailable}</dd>
        <dt>{msg.about.platform}</dt>
        <dd>{info ? msg.about.platformValue(info.os, info.arch) : msg.about.unavailable}</dd>
        <dt>{msg.about.runtime}</dt>
        <dd>{info ? msg.about.runtimeValue(info.tauriVersion, info.webviewVersion) : msg.about.unavailable}</dd>
      </dl>
      <div className="stack-sm">
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard
                .writeText(versionReport(version, info))
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            <IconCopy size={14} />
            <span aria-live="polite">{copied ? msg.common.copied : msg.about.copy}</span>
          </button>
        </div>
        <span className="hint">{msg.about.copyHint}</span>
      </div>
      <div className="stack-sm">
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm" onClick={() => open(msg.settings.releasesUrl)}>
            <IconExternalLink size={14} />
            {msg.about.releases}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => open(msg.about.licenceUrl)}>
            <IconExternalLink size={14} />
            {msg.about.licence}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => open(msg.about.thirdPartyUrl)}>
            <IconExternalLink size={14} />
            {msg.about.thirdParty}
          </button>
        </div>
        <span className="hint">{msg.about.releasesHint}</span>
      </div>
    </section>
  );
}
