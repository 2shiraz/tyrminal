// Components loaded on first use (code splitting): views, side panels and dialogs that are not
// needed for the first paint of Hosts. Each one carries its own Suspense boundary, so loading one
// never hides what is already on screen around it; until its chunk arrives it shows `fallback`
// (nothing by default). The chunk is fetched from the application bundle on disk: no network.
import { type ComponentType, type ReactNode, Suspense, lazy } from "react";

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  function Loaded(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return Loaded;
}
