import type { HostOs } from "@tyrminal/contracts";
import type { CSSProperties } from "react";

import { msgD, osNames } from "../../lib/messages-d";

/** A short mark and a hue per OS. Generic letter marks rather than vendor logos (trademarks). */
const MARKS: Record<HostOs, { mark: string; hue: number }> = {
  linux: { mark: "Lx", hue: 48 },
  ubuntu: { mark: "Ub", hue: 18 },
  debian: { mark: "Db", hue: 340 },
  fedora: { mark: "Fd", hue: 215 },
  red_hat: { mark: "RH", hue: 0 },
  centos: { mark: "Ce", hue: 290 },
  alpine: { mark: "Al", hue: 205 },
  arch: { mark: "Ar", hue: 195 },
  suse: { mark: "Su", hue: 130 },
  raspberry_pi: { mark: "Pi", hue: 330 },
  free_bsd: { mark: "FB", hue: 355 },
  open_bsd: { mark: "OB", hue: 45 },
  macos: { mark: "Mc", hue: 230 },
  windows: { mark: "Wi", hue: 200 },
  network_device: { mark: "Nw", hue: 160 },
};

export const OS_CHOICES = Object.keys(MARKS) as HostOs[];

/** The host tile's OS icon. Named for assistive technology, unlike the decorative avatar. */
export function OsIcon({ os, size = "md" }: { os: HostOs; size?: "sm" | "md" }) {
  const { mark, hue } = MARKS[os];
  const name = osNames[os];
  return (
    <span
      className={`avatar os-icon ${size === "sm" ? "avatar-sm" : ""}`}
      style={{ "--hue": hue } as CSSProperties}
      role="img"
      aria-label={msgD.inventory.osLabel(name)}
      title={name}
      data-os={os}
    >
      {mark}
    </span>
  );
}
