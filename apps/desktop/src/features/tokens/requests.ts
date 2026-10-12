// Requests from a terminal to the rest of the window, without passing callbacks through every
// layout component: "open the new-host editor prefilled with this address". Only this app's code
// can publish; a request opens an editor and never connects.

export interface NewHostRequest {
  address: string;
  port: number;
}

const listeners = new Set<(request: NewHostRequest) => void>();

export function requestNewHost(request: NewHostRequest): void {
  for (const listener of listeners) listener(request);
}

export function onNewHostRequest(listener: (request: NewHostRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
