// Afterglow, the experimental UI (docs/experimental/afterglow-plan.md §8). Branch-only.
//
// `TYRMINAL_UI=experimental` turns this on; without it `expPlugins()` returns nothing and main's
// build is byte-for-byte what it was. When on, one plugin:
//   - swaps a whitelist of presentational modules for replacements under src/exp/ (same exports and
//     props; src/exp/parity.ts makes typecheck fail when main changes a signature),
//   - appends the Afterglow entry (styles, runtime) after main.tsx's own imports, so its CSS loads
//     after styles/global.css,
//   - marks the document `data-ui="afterglow"`, which every Afterglow rule is scoped under,
//   - writes to dist-exp/, so main's dist/ and its tests never see experimental output.
// No new IPC, capabilities or CSP: everything here is front-end only and self-hosted.
// Plain JavaScript (types in vite.exp.d.mts) so vite.config.ts can import it with its extension.
/** @typedef {import("vite").Plugin} Plugin */

const env = globalThis.process?.env ?? {};

export const EXPERIMENTAL_UI = env.TYRMINAL_UI === "experimental";

/** Main module (relative to src/, with extension) → its Afterglow replacement (relative to src/). */
/** @type {Record<string, string>} */
const SWAPS = {
  "features/terminal/schemes.ts": "exp/terminal/schemes.ts",
  "components/ui/Toasts.tsx": "exp/ui/Toasts.tsx",
  "components/ui/icons.tsx": "exp/ui/icons.tsx",
  "components/layout/TabStrip.tsx": "exp/layout/TabStrip.tsx",
};

/** Vite ids use forward slashes; a Windows drive keeps its letter (C:/...). */
/** @returns {string} */
function srcDir() {
  const path = decodeURIComponent(new URL("./src/", import.meta.url).pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** @returns {Plugin} */
function afterglow() {
  const src = srcDir();
  const exp = `${src}exp/`;
  return {
    name: "tyrminal-afterglow",
    enforce: "pre",
    config: () => ({ build: { outDir: "dist-exp" } }),
    async resolveId(source, importer, options) {
      // Replacements may import the module they replace; only main's importers are redirected.
      if (!importer || importer.startsWith(exp)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !resolved.id.startsWith(src)) return null;
      const target = SWAPS[resolved.id.slice(src.length).split("?")[0] ?? ""];
      return target ? `${src}${target}` : null;
    },
    transform(code, id) {
      if (id === `${src}main.tsx`) return { code: `${code}\nimport "./exp/entry";\n`, map: null };
      return null;
    },
    transformIndexHtml: (html) => html.replace("<html lang=\"en\">", "<html lang=\"en\" data-ui=\"afterglow\">"),
  };
}

/** @returns {Plugin[]} */
export function expPlugins() {
  return EXPERIMENTAL_UI ? [afterglow()] : [];
}
