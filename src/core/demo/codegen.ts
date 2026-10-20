import type { ChangedFile, FileDiff, FileStatus } from "@/core/gen";
import { hash, Rng } from "./rng";

/** Synthetic-but-plausible source lines per language, used to build realistic unified diffs. */
const LINES: Record<string, string[]> = {
  ts: [
    "export function {name}({arg}: {Type}): {Type} {",
    "  const {var} = useStore((s) => s.{field});",
    "  if (!{var}) return null;",
    "  return {var}.map((item) => ({ ...item, {field}: true }));",
    "}",
    "const {VAR} = {num};",
    "import { {Type} } from \"./{name}\";",
    "  await {name}({var}, { signal: controller.signal });",
    "  // Keep the order stable so keyboard navigation doesn't jump.",
    "  {var}.sort((a, b) => a.order - b.order);",
    "  expect({name}({var})).toEqual({ ok: true });",
    "  it(\"{phrase}\", async () => {",
    "  });",
    "  set((s) => ({ {field}: [...s.{field}, {var}] }));",
    "export interface {Type} { id: string; {field}: number }",
    "  return () => clearInterval(timer);",
    "  const [{var}, set{Type}] = useState<{Type} | null>(null);",
  ],
  tsx: [
    "export function {Type}({ {var} }: { {var}: {Type} }) {",
    "  return (",
    "    <div className=\"flex items-center gap-2\">",
    "      <{Type} {field}={{var}} />",
    "    </div>",
    "  );",
    "}",
    "  const {var} = useAgent(key);",
    "      {{var} && <Badge tone=\"sun\">{phrase}</Badge>}",
    "  useEffect(() => openSession(key), [key]);",
    "      <motion.div layout transition={spring.soft}>",
    "      </motion.div>",
  ],
  kt: [
    "class {Type}(private val {var}: {Type}) {",
    "    fun {name}(): Flow<{Type}> = {var}.events()",
    "        .filter { it.state == AgentState.Blocked }",
    "        .distinctUntilChangedBy { it.paneId }",
    "}",
    "    @Test fun `{phrase}`() = runTest {",
    "        assertEquals({num}, {var}.size)",
    "    }",
    "import dev.teleflock.notify.{Type}",
    "    private val {var} = MutableStateFlow<{Type}?>(null)",
  ],
  go: [
    "func ({var} *{Type}) {name}(ctx context.Context) error {",
    "\tif err := {var}.pool.Ping(ctx); err != nil {",
    "\t\treturn fmt.Errorf(\"{phrase}: %w\", err)",
    "\t}",
    "\treturn nil",
    "}",
    "\t{var} := pgxpool.New(ctx, cfg.DatabaseURL)",
    "\tdefer {var}.Close()",
    "type {Type} struct { {field} int }",
  ],
  yml: [
    "      - uses: actions/cache@v4",
    "        with:",
    "          path: ~/.bun/install/cache",
    "          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}",
    "      - run: bun install --frozen-lockfile",
    "      - run: bunx turbo run build --cache-dir=.turbo",
    "    timeout-minutes: {num}",
    "  {name}:",
    "    runs-on: ubuntu-latest",
  ],
  css: [
    ".{name} {",
    "  background: linear-gradient(120deg, #f053d0, #a15eef 45%, #7fa2e7);",
    "  animation: {name} {num}s ease-in-out infinite;",
    "}",
    "@keyframes {name} { to { transform: translateY(-{num}px); } }",
    "  border-radius: {num}px;",
  ],
  md: [
    "## {Phrase}",
    "",
    "TeleFlock talks to `tf-hostd` over a single SSH exec channel.",
    "- {phrase}",
    "```sh",
    "herdr --session tf-lab agent list",
    "```",
  ],
  sql: [
    "CREATE TABLE {name} (",
    "  tenant_id uuid NOT NULL,",
    "  window_start timestamptz NOT NULL,",
    "  hits integer NOT NULL DEFAULT 0,",
    "  PRIMARY KEY (tenant_id, window_start)",
    ");",
    "CREATE INDEX {name}_idx ON {name} (tenant_id);",
  ],
  json: ['  "{name}": "^{num}.{num}.0",', '  "{field}": true,', "  {", "  },"],
};

const WORDS = {
  name: ["persistLanes", "reconnect", "watchState", "rateLimit", "poolStats", "flushQueue", "loadSnapshot", "hero", "glow", "drift"],
  Type: ["LaneState", "AgentEvent", "PoolConfig", "Bucket", "HerdrClient", "Snapshot", "Card", "Tenant", "Watcher"],
  var: ["lanes", "event", "pool", "bucket", "client", "snapshot", "card", "tenant", "queue"],
  VAR: ["MAX_RETRIES", "WINDOW_MS", "POOL_SIZE", "BACKOFF_CAP"],
  field: ["order", "since", "archived", "hits", "idle", "size", "stale"],
  arg: ["input", "opts", "state", "ctx"],
  phrase: ["keeps lane order after reload", "debounces blocked flaps", "survives reconnect mid-stream", "reuses idle connections", "drops stale windows"],
  Phrase: ["Architecture", "Connection model", "Getting started", "Troubleshooting"],
  num: ["3", "8", "12", "30", "64", "250"],
};

export function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  if (ext === "ts" || ext === "js" || ext === "mjs") return "ts";
  if (ext === "tsx" || ext === "jsx") return "tsx";
  if (ext === "kts" || ext === "kt") return "kt";
  if (ext === "yaml") return "yml";
  if (ext in LINES) return ext;
  return "ts";
}

function fill(template: string, rng: Rng): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const pool = (WORDS as Record<string, string[]>)[k];
    return pool ? rng.pick(pool) : m;
  });
}

/** Deterministic plausible code line for a file. */
export function codeLine(path: string, rng: Rng): string {
  return fill(rng.pick(LINES[langOf(path)] ?? (LINES.ts as string[])), rng);
}

/**
 * Unified diff with exactly `added` + / `removed` − lines, spread over hunks with context.
 * Deterministic per (path, counts).
 */
export function makePatch(path: string, added: number, removed: number, status: FileStatus = "modified", oldPath?: string): string {
  const rng = new Rng(hash(`${path}:${added}:${removed}`));
  const a = status === "added" || status === "untracked" ? "/dev/null" : `a/${oldPath ?? path}`;
  const b = status === "deleted" ? "/dev/null" : `b/${path}`;
  const out: string[] = [`diff --git a/${oldPath ?? path} b/${path}`];
  if (status === "renamed" && oldPath) out.push("similarity index 87%", `rename from ${oldPath}`, `rename to ${path}`);
  if (status === "added" || status === "untracked") out.push("new file mode 100644");
  if (status === "deleted") out.push("deleted file mode 100644");
  out.push(`index ${rng.hex(7)}..${rng.hex(7)} 100644`, `--- ${a}`, `+++ ${b}`);
  if (added === 0 && removed === 0) return out.join("\n");
  if (status === "added" || status === "untracked") {
    out.push(`@@ -0,0 +1,${added} @@`);
    for (let i = 0; i < added; i++) out.push(`+${codeLine(path, rng)}`);
    return out.join("\n");
  }
  if (status === "deleted") {
    out.push(`@@ -1,${removed} +0,0 @@`);
    for (let i = 0; i < removed; i++) out.push(`-${codeLine(path, rng)}`);
    return out.join("\n");
  }
  let addLeft = added;
  let delLeft = removed;
  let oldLine = rng.int(4, 30);
  let newLine = oldLine;
  while (addLeft > 0 || delLeft > 0) {
    const hunkAdd = Math.min(addLeft, Math.max(addLeft > 0 ? 1 : 0, rng.int(2, 24)));
    const hunkDel = Math.min(delLeft, Math.max(delLeft > 0 ? 1 : 0, rng.int(0, 10)));
    const ctx = 3;
    const body: string[] = [];
    for (let i = 0; i < ctx; i++) body.push(` ${codeLine(path, rng)}`);
    for (let i = 0; i < hunkDel; i++) body.push(`-${codeLine(path, rng)}`);
    for (let i = 0; i < hunkAdd; i++) body.push(`+${codeLine(path, rng)}`);
    for (let i = 0; i < ctx; i++) body.push(` ${codeLine(path, rng)}`);
    out.push(`@@ -${oldLine},${ctx * 2 + hunkDel} +${newLine},${ctx * 2 + hunkAdd} @@`);
    out.push(...body);
    const gap = rng.int(8, 60);
    oldLine += ctx * 2 + hunkDel + gap;
    newLine += ctx * 2 + hunkAdd + gap;
    addLeft -= hunkAdd;
    delLeft -= hunkDel;
  }
  return out.join("\n");
}

export function fileDiff(f: ChangedFile): FileDiff {
  return {
    path: f.path,
    patch: makePatch(f.path, f.added, f.removed, f.status, f.oldPath),
    added: f.added,
    removed: f.removed,
    status: f.status,
    lang: langOf(f.path),
  };
}

/** Plausible file body for `fs.read` / read tool previews. */
export function fileBody(path: string, lines = 60): string {
  const rng = new Rng(hash(path));
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(codeLine(path, rng));
  return out.join("\n");
}
