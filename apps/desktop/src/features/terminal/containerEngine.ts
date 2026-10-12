import type { ContainerEngine } from "@tyrminal/contracts";

/** The engine's display name (P-33). Its own module: the shell names it without loading the dialog. */
export const engineName = (engine: ContainerEngine) => (engine === "docker" ? "Docker" : "Podman");
