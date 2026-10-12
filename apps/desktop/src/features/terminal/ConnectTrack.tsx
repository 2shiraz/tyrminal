import type { ChainPosition } from "@tyrminal/contracts";
import type { CSSProperties } from "react";

import { IconCheck, IconPlug, IconTerminal, IconX } from "../../components/ui/icons";
import { msgConnect } from "../../lib/messages-connect";
import type { TimelineEntry } from "./ConnectionSheet";
import "./connect-track.css";

/** The stops on the track, each made of the session states that belong to it. */
const STAGES = [
  { id: "resolve", steps: ["resolving"] },
  { id: "connect", steps: ["connecting", "keys"] },
  { id: "verify", steps: ["verifying_host"] },
  { id: "auth", steps: ["authenticating"] },
  { id: "shell", steps: ["opening_channel"] },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export type StageState = "done" | "now" | "waiting" | "fail" | "pending";

const stageOf = (step: string) => STAGES.findIndex((s) => (s.steps as readonly string[]).includes(step));
const atDestination = (hop: ChainPosition | null | undefined) => !hop || hop.index === hop.total;

/**
 * Each stop's state, from the events the session reported and nothing else: the furthest stage
 * the destination reached is the current one (through jump hosts, "connect" until the destination
 * itself answers). A prompt holds the travel at its stop; a failure marks the stop it happened at.
 */
export function trackStates(input: {
  timeline: TimelineEntry[];
  failed: boolean;
  hostKeyChanged: boolean;
  trust: boolean;
  auth: boolean;
  connected: boolean;
}): StageState[] {
  if (input.connected) return STAGES.map(() => "done");
  let current = 0;
  for (const entry of input.timeline) {
    const index = stageOf(entry.step);
    if (index < 0) continue;
    current = Math.max(current, atDestination(entry.hop) ? index : Math.min(index, 1));
  }
  if (input.hostKeyChanged) current = 2;
  else if (input.trust) current = Math.max(current, 2);
  else if (input.auth) current = Math.max(current, 3);
  const at: StageState = input.failed || input.hostKeyChanged ? "fail" : input.trust || input.auth ? "waiting" : "now";
  return STAGES.map((_, index) => (index < current ? "done" : index === current ? at : "pending"));
}

/** One stop on the track. */
export interface TrackStop {
  id: string;
  label: string;
  state: StageState;
}

/** The connection's stops, from `trackStates`. */
export function connectionStops(states: StageState[]): TrackStop[] {
  return STAGES.map((stage, index) => ({ id: stage.id, label: msgConnect.track[stage.id], state: states[index] ?? "pending" }));
}

/**
 * The track from this computer to the shell. It only follows events: a stop lights when its step
 * arrives, so it never runs ahead of the connection and never holds it back. Decorative (the step
 * list below says the same in words), so it is hidden from assistive technology.
 */
export function ConnectTrack({ states, stops: given, lead = [] }: { states?: StageState[]; stops?: TrackStop[]; lead?: TrackStop[] | undefined }) {
  // `lead`: stops passed before the connection began (quick connect's setup), shown done.
  const stops = given ?? [...lead, ...connectionStops(states ?? [])];
  const current = stops.findIndex((s) => s.state !== "done");
  const settled = current === -1;
  // Rail points: this computer at 0, the stops at 1..n, the shell at n + 1.
  const points = stops.length + 1;
  const reached = settled ? points : current + 1;
  const state = settled ? "done" : (stops[current] as TrackStop).state;
  return (
    <div className="connect-track" data-state={state} aria-hidden="true" data-testid="connect-track">
      <span className="track-end track-from" data-state={state}>
        <IconPlug size={15} />
      </span>
      <div className="track-rail" style={{ "--reached": reached / points, "--segment": `${100 / points}%` } as CSSProperties}>
        <span className="track-line" />
        <span className="track-fill" />
        {state === "fail" && <span className="track-failseg" style={{ "--from": (reached - 1) / points } as CSSProperties} />}
        {state === "now" && (
          // The segment being travelled, from the last stop reached to the current one.
          <span className="track-travel" style={{ "--from": (reached - 1) / points } as CSSProperties}>
            <span />
          </span>
        )}
        {stops.map((stop, index) => (
          <span key={stop.id} className="track-stop" data-stage={stop.id} data-state={stop.state} style={{ "--at": (index + 1) / points } as CSSProperties}>
            <span className="track-dot">
              {stop.state === "done" && <IconCheck size={11} />}
              {stop.state === "fail" && <IconX size={11} />}
            </span>
            <span className="track-label">{stop.label}</span>
          </span>
        ))}
      </div>
      <span className="track-end track-to" data-state={state}>
        <IconTerminal size={15} />
      </span>
    </div>
  );
}
