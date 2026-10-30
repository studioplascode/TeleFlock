import { apiError } from "../errors";
import type { Agent, ArtifactContent, ArtifactFile, ArtifactKind, ContextXray, LocalWritten, SessionArtifacts, XrayCategory, XrayEntry } from "../gen";

/**
 * Demo host: a session's artifacts (`session.artifacts`, `session.artifact`), pasted texts saved
 * into it (`session.writeLocal`, kept in memory per agent) and its context X-ray
 * (`session.context`), derived from the demo agent.
 */

interface Fixture {
  kind: ArtifactKind;
  name: string;
  ageMin: number;
  text: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";

/** Texts `session.writeLocal` saved, per agent id. */
const saved = new Map<string, { name: string; text: string; at: number }[]>();
/** hostd's cap (`ops/artifact_files.rs` MAX_LOCAL_WRITE). */
const MAX_LOCAL_WRITE = 4 << 20;

function fixtures(agent: Agent): Fixture[] {
  const topic = agent.title || agent.name;
  const plan = `${slug(topic)}-plan.md`;
  const out: Fixture[] = [
    {
      kind: "local",
      name: plan,
      ageMin: 42,
      text: `# Plan: ${topic}\n\n## Context\nThe current behaviour is covered by the existing tests; nothing on the board depends on the old shape.\n\n## Steps\n1. Read the module and its callers.\n2. Change the data shape in one place.\n3. Update the callers and their tests.\n4. Run \`bun test\` and the typecheck.\n\n## Risks\n- Cached state written by older builds.\n- A caller outside the repo (none found).\n`,
    },
    {
      kind: "local",
      name: "reports/findings.md",
      ageMin: 18,
      text: `# Findings\n\n| Area | Status |\n|---|---|\n| Parser | ✅ covered |\n| Cache | ⚠️ stale entries survive a restart |\n| UI | ✅ |\n\nThe cache keeps entries written by builds before 0.6, which still parse but carry no version.\n`,
    },
    { kind: "local", name: "scratch/notes.txt", ageMin: 9, text: "todo: re-run the flaky suite with --rerun-each 20\nlast failure: test/cache.test.ts:88 (timeout)\n" },
    {
      kind: "agent",
      name: "0-Explore.md",
      ageMin: 25,
      text: `## Explore: where is the cache written?\n\n- \`src/core/cache.ts:41\` writes it on every flush.\n- \`src/core/cache.ts:97\` reads it at start; no version check.\n- Nothing else touches the file.\n`,
    },
    { kind: "agent", name: "0-Explore/0-Explore.1-Grep.md", ageMin: 26, text: "3 hits for `cacheVersion` (all in tests).\n" },
  ];
  if (agent.turns > 3)
    out.push({ kind: "handoff", name: "handoff-2026-10-29T07-12-44-210Z.md", ageMin: 70, text: `# Handoff\n\nWorking on: ${topic}.\n\nDone: plan approved, parser updated.\nNext: migrate the cache, then the UI.\n` });
  return out;
}

const urlOf = (f: Fixture) => (f.kind === "local" ? `local://${f.name}` : f.kind === "agent" ? `agent://${f.name.slice(f.name.lastIndexOf("/") + 1, -3)}` : undefined);

function files(agent: Agent, now: number): ArtifactFile[] {
  const pasted = (saved.get(agent.id) ?? []).map((s): ArtifactFile => ({ kind: "local", name: s.name, url: `local://${s.name}`, size: new TextEncoder().encode(s.text).length, mtime: s.at }));
  return fixtures(agent)
    .map((f): ArtifactFile => ({ kind: f.kind, name: f.name, url: urlOf(f), size: new TextEncoder().encode(f.text).length, mtime: now - f.ageMin * 60_000, title: /^#{1,3} (.+)$/m.exec(f.text)?.[1] }))
    .concat(pasted)
    .sort((a, b) => b.mtime - a.mtime);
}

/** omp's overview split: largest remainder of `total` by `weights`. */
function allocate(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const shares = weights.map((w, i) => ({ i, t: Math.floor((total * w) / sum), r: (total * w) / sum - Math.floor((total * w) / sum) }));
  let left = total - shares.reduce((a, s) => a + s.t, 0);
  for (const s of [...shares].sort((a, b) => b.r - a.r || a.i - b.i)) if (left-- > 0) s.t++;
  return shares.map((s) => s.t);
}

const entry = (id: string, label: string, tokens: number, preview: string, callId?: string): XrayEntry => ({ id, label, tokens, preview, chars: tokens * 4, callId });

function xray(agent: Agent, now: number): ContextXray {
  const window = agent.omp?.context?.window ?? 200_000;
  const used = agent.omp?.context?.tokens ?? 42_180;
  const threshold = Math.round(window * 0.85);
  const outputs: XrayEntry[] = [
    entry("tool-output/41/41", "bash", 6120, "$ bun test src/board ✓ 212 pass ✗ 3 fail lanes.test.ts:88 expected 4 received 5 …", "demo-call-41"),
    entry("tool-output/12/12", "read", 3880, "src/features/board/lanes.ts 1| import { type Agent } from \"@/core/gen\"; 2| …"),
    entry("tool-output/57/57", "bash", 2410, "$ git diff --stat src/board/lanes.ts | 14 +++++++--- 1 file changed …"),
    entry("tool-output/30/30", "grep", 960, "src/features/board/Lane.tsx:31: QUIET_AFTER_MS …"),
  ];
  const base: Omit<XrayCategory, "tokens">[] = [
    { id: "system-prompt", label: "System Prompt (excluding Skills)", weight: 9874, entries: 3, children: [], top: [entry("system-prompt/0", "System Block 1", 10_102, "You are omp, a coding agent running in the user's terminal …")] },
    { id: "skills", label: "Skills", weight: 233, entries: 0, children: [], top: [] },
    { id: "built-in-tools", label: "Built-in Tools", weight: 11_002, entries: 24, children: [], top: [entry("built-in-tools/3", "edit", 1840, "Edit a file by replacing exact text …"), entry("built-in-tools/0", "bash", 1210, "Run a shell command …")] },
    { id: "custom-tools", label: "Custom Tools", weight: 0, entries: 0, children: [], top: [] },
    { id: "user-messages", label: "User / Developer Messages", weight: 2140, entries: 6, children: [], top: [entry("user-messages/0/0", "user · message 1", 860, agent.title || "Fix the lanes")] },
    { id: "assistant-messages", label: "Assistant Messages", weight: 3010, entries: 14, children: [], top: [] },
    { id: "assistant-thinking", label: "Assistant Thinking", weight: 4420, entries: 9, children: [], top: [entry("assistant-thinking/40/40/0", "Thinking · Message 41", 1320, "The failing test expects 4 lanes; the quiet lane was split …")] },
    { id: "tool-calls", label: "Tool Calls", weight: 1180, entries: 21, children: [], top: [] },
    { id: "tool-output", label: "Tool Output", weight: 13_370, entries: 21, children: [], top: outputs },
  ];
  const shares = allocate(base.map((c) => c.weight), used);
  const out = shares[8] ?? 0;
  const [bash = 0, read = 0, grep = 0] = allocate([8530, 3880, 960], out);
  const categories: XrayCategory[] = base.map((c, i) => ({ ...c, tokens: shares[i] ?? 0 }));
  categories[8]!.children = [
    { label: "bash", tokens: bash, weight: 8530, entries: 9 },
    { label: "read", tokens: read, weight: 3880, entries: 8 },
    { label: "grep", tokens: grep, weight: 960, entries: 4 },
  ];
  const buffer = Math.min(window - threshold, Math.max(0, window - used));
  return { source: "omp", model: agent.omp?.model?.label ?? agent.omp?.model?.id, window, used, buffer, free: Math.max(0, window - used - buffer), threshold, categories, images: agent.turns % 2 === 0 ? 2 : 0, dropImages: true, at: now };
}

/** `session.artifacts` / `session.artifact` / `session.writeLocal` / `session.context` for a demo agent. */
export function demoInsight(method: string, p: Record<string, unknown>, agent: Agent, now: number, home: string): unknown {
  if (agent.kind !== "omp") throw apiError("unsupported", `${agent.name} is a ${agent.kind} agent; only omp sessions have artifacts`);
  const dir = `${home}/.omp/agent/sessions/-demo/2026-10-29T07-00-00-000Z_${agent.id}`;
  if (method === "session.artifacts") return { dir, localRoot: `${dir}/local`, files: files(agent, now), truncated: false } satisfies SessionArtifacts;
  if (method === "session.writeLocal") {
    // As tf-hostd: the next `paste-<n>.md` past every one there, owner-only, 4 MiB at most.
    const text = typeof p.text === "string" ? p.text : "";
    const size = new TextEncoder().encode(text).length;
    if (!size) throw apiError("invalid_params", "nothing to save");
    if (size > MAX_LOCAL_WRITE) throw apiError("invalid_params", `the text is ${(size / (1 << 20)).toFixed(1)} MiB; a paste can be at most 4 MiB`);
    const list = saved.get(agent.id) ?? [];
    const n = list.reduce((max, s) => Math.max(max, Number(/^paste-(\d+)\.md$/.exec(s.name)?.[1] ?? 0)), 0) + 1;
    const name = `paste-${n}.md`;
    saved.set(agent.id, [...list, { name, text, at: now }]);
    return { name, url: `local://${name}`, path: `${dir}/local/${name}`, size } satisfies LocalWritten;
  }
  if (method === "session.artifact") {
    const pasted = p.kind === "local" ? saved.get(agent.id)?.find((s) => s.name === p.name) : undefined;
    if (pasted) {
      const size = new TextEncoder().encode(pasted.text).length;
      return { kind: "local", name: pasted.name, url: `local://${pasted.name}`, path: `${dir}/local/${pasted.name}`, size, mtime: pasted.at, text: pasted.text, truncated: false, binary: false } satisfies ArtifactContent;
    }
    const f = fixtures(agent).find((x) => x.kind === p.kind && x.name === p.name);
    if (!f) throw apiError("not_found", `${String(p.name)} does not exist`);
    const size = new TextEncoder().encode(f.text).length;
    const path = f.kind === "local" ? `${dir}/local/${f.name}` : `${dir}/${f.name}`;
    return { kind: f.kind, name: f.name, url: urlOf(f), path, size, mtime: now - f.ageMin * 60_000, text: f.text, truncated: false, binary: false } satisfies ArtifactContent;
  }
  if (agent.parked) throw apiError("parked", `${agent.name} is done and its pane is closed`, { hint: "Resume it first" });
  return xray(agent, now);
}
