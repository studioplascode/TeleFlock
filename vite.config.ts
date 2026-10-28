import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import babel, { type RolldownBabelPreset } from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { defineConfig, type Logger, type Plugin } from "vite";

// Tauri sets TAURI_DEV_HOST when `tauri android dev` needs the dev server on the LAN.
const host = process.env.TAURI_DEV_HOST;

const require = createRequire(import.meta.url);
// @babel/core 7 ships no type declarations; this is the one call the guard makes.
const babelCore = require("@babel/core") as { version: string; transformAsync(code: string, options: object): Promise<unknown> };
// package.json's version (createRequire returns untyped JSON).
const pkgVersion: unknown = require("./package.json").version;

/** Everyday component syntax the React Compiler must compile: one component and one hook. */
const CANARY = `
import { useEffect, useMemo, useState } from "react";
type Item = { id: string; label?: string; tags?: readonly string[] };
export function Canary({ title = "canary", items = [], onPick, ...rest }: { title?: string; items?: Item[]; onPick?: (id: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [first = null, ...others] = items;
  const { length = 0 } = items;
  const tagged = useMemo(() => items.filter((i) => i.tags?.includes(title) ?? false), [items, title]);
  useEffect(() => {
    if (open && first) onPick?.(first.id);
  }, [open, first, onPick]);
  return (
    <div {...rest} title={\`\${title} \${length}\`} onClick={() => setOpen((o) => !o)}>
      {tagged.map(({ id, label = id }) => <span key={id}>{label}</span>)}
      {others.length > 0 && <>{others.length} more</>}
    </div>
  );
}
export function useCanary(key: string, fallback = 0): number {
  const [n] = useState(() => key.length || fallback);
  return n;
}
`;
const CANARY_FUNCTIONS = 2;

/**
 * The React Compiler leaves a function it can't compile as it is and says nothing (panicThreshold
 * "none"), so a toolchain change can quietly un-memoize most components: under @babel/core 8 every
 * destructuring default bailed out (AssignmentPattern is no longer an LVal in @babel/types 8; 86
 * functions in 0.5.0), hence the @babel/core 7 pin in package.json. `vite build` first compiles a
 * canary of everyday component syntax and fails when the compiler skips any of it. Components that
 * bail out for reasons of their own (try/finally, refs read during render, an eslint suppression)
 * don't fail the build; its log counts them (TF_COMPILER_REPORT=1 lists them).
 */
function reactCompiler(): { preset: RolldownBabelPreset; guard: Plugin } {
  let compiled = 0;
  const skipped = new Map<string, string>();
  const preset = reactCompilerPreset({
    logger: {
      logEvent(filename, event) {
        if (event.kind === "CompileSuccess") compiled++;
        else if (event.kind === "CompileError" || event.kind === "PipelineError")
          skipped.set(`${filename}:${event.fnLoc?.start.line ?? "?"}`, event.kind === "CompileError" ? event.detail.reason : event.data.split("\n")[0]);
      },
    },
  });
  let log: Logger | undefined;
  const guard: Plugin = {
    name: "teleflock:react-compiler-guard",
    apply: "build",
    configResolved(config) {
      log = config.logger;
    },
    async buildStart() {
      const events: LoggerEvent[] = [];
      await babelCore.transformAsync(CANARY, {
        filename: "react-compiler-canary.tsx",
        babelrc: false,
        configFile: false,
        code: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [[require.resolve("babel-plugin-react-compiler"), { logger: { logEvent: (_file: string | null, event: LoggerEvent) => events.push(event) } }]],
      });
      if (events.filter((e) => e.kind === "CompileSuccess").length === CANARY_FUNCTIONS) return;
      const why = events.flatMap((e) => (e.kind === "CompileError" ? [e.detail.reason] : e.kind === "PipelineError" ? [e.data.split("\n")[0]] : []));
      this.error(
        `React Compiler skips everyday component syntax under @babel/core ${babelCore.version} (${[...new Set(why)].join("; ") || "no CompileSuccess"}): ` +
          "most components would ship unmemoized. Use a @babel/core release babel-plugin-react-compiler supports (see vite.config.ts).",
      );
    },
    buildEnd() {
      log?.info(`react-compiler: ${compiled} functions compiled, ${skipped.size} skipped`);
      if (process.env.TF_COMPILER_REPORT) for (const [at, reason] of skipped) log?.info(`  ${at}: ${reason}`);
    },
  };
  return { preset, guard };
}

const compiler = reactCompiler();

export default defineConfig({
  plugins: [react(), compiler.guard, babel({ presets: [compiler.preset] }), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    host: host || "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**", "**/.research/**", "**/drafts/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The app's own version (package.json, kept in step by scripts/set-version.sh) for the in-browser demo's app.info.
  define: { __APP_VERSION__: JSON.stringify(typeof pkgVersion === "string" ? pkgVersion : "dev") },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Assets load from local disk inside Tauri, so bundle size matters far less than on the web.
    chunkSizeWarningLimit: 1024,
  },
});
