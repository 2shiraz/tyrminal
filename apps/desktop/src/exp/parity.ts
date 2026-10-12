// Afterglow (experimental UI, branch only): every swapped module must keep the shape of the module
// it replaces, so `pnpm typecheck` fails as soon as main changes a signature the swap relies on.
// Never imported at run time.
import type * as MainToasts from "../components/ui/Toasts";
import type * as MainSchemes from "../features/terminal/schemes";
import type * as ExpToasts from "./ui/Toasts";
import type * as ExpSchemes from "./terminal/schemes";

/** Compiles only when the replacement offers everything the original exports, with the same types. */
type Same<Main, Exp extends Main> = Exp;

export type Parity = [Same<typeof MainToasts, typeof ExpToasts>, Same<typeof MainSchemes, typeof ExpSchemes>];
