// Afterglow (experimental UI, branch only): every swapped module must keep the shape of the module
// it replaces, so `pnpm typecheck` fails as soon as main changes a signature the swap relies on.
// Never imported at run time.
import type * as MainTabStrip from "../components/layout/TabStrip";
import type * as MainIcons from "../components/ui/icons";
import type * as MainToasts from "../components/ui/Toasts";
import type * as MainHostPanel from "../features/hosts/HostPanel";
import type * as MainConnectionPanel from "../features/sidepanel/ConnectionPanel";
import type * as MainSchemes from "../features/terminal/schemes";
import type * as ExpTabStrip from "./layout/TabStrip";
import type * as ExpIcons from "./ui/icons";
import type * as ExpToasts from "./ui/Toasts";
import type * as ExpHostPanel from "./hosts/HostPanel";
import type * as ExpConnectionPanel from "./sidepanel/ConnectionPanel";
import type * as ExpSchemes from "./terminal/schemes";

/** Compiles only when the replacement offers everything the original exports, with the same types. */
type Same<Main, Exp extends Main> = Exp;

export type Parity = [
  Same<typeof MainToasts, typeof ExpToasts>,
  Same<typeof MainSchemes, typeof ExpSchemes>,
  Same<typeof MainIcons, typeof ExpIcons>,
  Same<typeof MainTabStrip, typeof ExpTabStrip>,
  Same<typeof MainHostPanel, typeof ExpHostPanel>,
  Same<typeof MainConnectionPanel, typeof ExpConnectionPanel>,
];
