import { Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button, cn, Field, IconButton, Input, Select, Switch } from "@/design";
import { type FieldErrors, parseFieldError, ruleErrors, slugify, validTool, NAME_MAX } from "@/core/forward";
import type { ForwardRule } from "@/core/gen";
import { toApiError } from "@/core";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { Banner } from "@/features/mcp/parts";
import { saveRule, removeRule } from "./actions";
import type { ForwardHost } from "./hosts";
import { SUGGESTED_TOOL, shadowedTools } from "./model";

interface Form {
  fromHost: string;
  toHost: string;
  name: string;
  /** The name was typed: stop following the to-host's label. */
  nameEdited: boolean;
  enabled: boolean;
  shell: boolean;
  tools: string[];
  ports: { listen: string; target: string }[];
}

/** A new rule starts from a remote host (an agent's box) to this computer when the host list says which is which. */
function startForm(hosts: readonly ForwardHost[], rules: readonly ForwardRule[], rule?: ForwardRule): Form {
  if (rule) {
    return {
      fromHost: rule.fromHost,
      toHost: rule.toHost,
      name: rule.name,
      nameEdited: true,
      enabled: rule.enabled,
      shell: rule.shell,
      tools: [...rule.tools],
      ports: rule.ports.map((p) => ({ listen: String(p.listen), target: String(p.target) })),
    };
  }
  const to = hosts.find((h) => h.kind === "local") ?? hosts[1] ?? hosts[0];
  const from = hosts.find((h) => h.id !== to?.id && h.kind !== "local") ?? hosts.find((h) => h.id !== to?.id) ?? hosts[0];
  const taken = rules.filter((r) => r.fromHost === from?.id).map((r) => r.name);
  return { fromHost: from?.id ?? "", toHost: to?.id ?? "", name: slugify(to?.name ?? "", taken), nameEdited: false, enabled: true, shell: true, tools: [], ports: [] };
}

function portNumber(s: string): number {
  const t = s.trim();
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

function toRule(f: Form, id: string): ForwardRule {
  return {
    id,
    fromHost: f.fromHost,
    toHost: f.toHost,
    name: f.name.trim(),
    enabled: f.enabled,
    shell: f.shell,
    tools: f.tools,
    // A row left blank is not a port.
    ports: f.ports.filter((p) => p.listen.trim() || p.target.trim()).map((p) => ({ listen: portNumber(p.listen), target: portNumber(p.target) })),
  };
}

export interface RuleEditorProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  hosts: readonly ForwardHost[];
  rules: readonly ForwardRule[];
  /** The rule to edit; absent: a new one. */
  rule?: ForwardRule;
}

/** Create or edit a forward (dialog on desktop, sheet on phones). Mount per opening. */
export function RuleEditor({ open, onOpenChange, hosts, rules, rule }: RuleEditorProps) {
  const [form, setForm] = useState<Form>(() => startForm(hosts, rules, rule));
  const [toolDraft, setToolDraft] = useState("");
  const [toolError, setToolError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [otherError, setOtherError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const adding = !rule;
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  const others = rules.filter((r) => r.id !== rule?.id);
  const problems = ruleErrors(toRule(form, rule?.id ?? ""), hosts, others);
  const shown: FieldErrors = { ...(tried ? problems : {}), ...serverErrors };
  /** Core messages start lowercase ("use 1–32…"): shown as sentences, except those that open with a host's name. */
  const cap = (m: string | null | undefined) => (m && !hosts.some((h) => m.startsWith(h.name)) ? m.charAt(0).toUpperCase() + m.slice(1) : (m ?? undefined));
  const fromName = form.fromHost ? nameOf(form.fromHost) : "the from host";
  const toName = form.toHost ? nameOf(form.toHost) : "the to host";

  const patch = (p: Partial<Form>, clears: (keyof FieldErrors)[] = []) => {
    setForm((f) => ({ ...f, ...p }));
    setOtherError(null);
    if (clears.length > 0) {
      setServerErrors((e) => {
        const next = { ...e };
        for (const k of clears) delete next[k];
        return next;
      });
    }
  };

  /** Name follows the to-host's label until typed over; a different from-host can free or take it. */
  const retarget = (p: { fromHost?: string; toHost?: string }) => {
    const next = { ...form, ...p };
    if (!form.nameEdited) {
      const taken = others.filter((r) => r.fromHost === next.fromHost).map((r) => r.name);
      patch({ ...p, name: slugify(nameOf(next.toHost), taken) }, ["fromHost", "toHost", "name"]);
    } else patch(p, ["fromHost", "toHost", "name", "ports"]);
  };

  const addTool = (raw: string) => {
    const names = raw.split(/[\s,]+/).filter(Boolean);
    if (names.length === 0) return;
    const bad = names.find((n) => !validTool(n));
    if (bad) {
      setToolError(`"${bad}" is not a command name (letters, digits, . _ + - only)`);
      return;
    }
    setToolError(null);
    patch({ tools: [...form.tools, ...names.filter((n, i) => !form.tools.includes(n) && names.indexOf(n) === i)] }, ["tools", "shell"]);
    setToolDraft("");
  };

  const onToolKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (toolDraft.trim()) {
        e.preventDefault();
        addTool(toolDraft);
      } else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !toolDraft && form.tools.length > 0) {
      patch({ tools: form.tools.slice(0, -1) });
    }
  };

  const save = () => {
    setTried(true);
    const pending = toolDraft.trim();
    const draft = pending ? form.tools.concat(pending.split(/[\s,]+/).filter((n) => n && !form.tools.includes(n))) : form.tools;
    const wire = toRule({ ...form, tools: draft }, rule?.id ?? "");
    const bad = ruleErrors(wire, hosts, others);
    setServerErrors({});
    if (Object.keys(bad).length > 0) {
      setForm((f) => ({ ...f, tools: draft }));
      setToolDraft("");
      return;
    }
    setSaving(true);
    saveRule(wire).then(
      () => onOpenChange(false),
      (err: unknown) => {
        const e = toApiError(err);
        const field = e.code === "invalid_params" ? parseFieldError(e.message) : null;
        if (field) setServerErrors({ [field.field]: field.message });
        else setOtherError([e.message, e.hint].filter(Boolean).join(" — "));
        setSaving(false);
      },
    );
  };

  /** The first port (from 9222, a headed Chrome's DevTools) nothing on the from-host listens on yet. */
  const suggestedPort = () => {
    const held = new Set(others.filter((r) => r.fromHost === form.fromHost).flatMap((r) => r.ports.map((p) => p.listen)));
    let port = 9222;
    while (held.has(port)) port++;
    return { listen: String(port), target: "9222" };
  };

  const hostOptions = hosts.map((h) => ({ value: h.id, label: h.name, hint: h.online ? undefined : "not connected" }));
  const count = form.ports.length;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={adding ? "New forward" : `Edit ${rule.name}`}
      description="Let the agents and shells on one host use another host."
      width={580}
      maxHeight="94dvh"
      footer={
        <div className="flex w-full items-center gap-2">
          {rule && (
            <Button
              variant="ghost"
              icon={<Trash2 />}
              className="mr-auto text-error"
              onClick={() => {
                removeRule(rule);
                onOpenChange(false);
              }}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" className={cn(!rule && "ml-auto")} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {adding ? "Create forward" : "Save"}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Banner tone="warn" title={`Everything on ${fromName} can then run commands as you on ${toName}`}>
          That includes its agents, and what they download or are told to do. Only turn this on for a host you trust. It works while this app runs connected to both hosts, and every use shows under In use, where you can stop it.
          <span className="mt-1.5 block">
            A forwarded port is open to every account on {fromName} while the forward is on, like <code className="font-mono">ssh -L</code>. On Linux TeleFlock accepts only your own user's connections; on macOS and Windows hosts any local account can connect.
          </span>
        </Banner>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From host" description="Agents and shells here…" error={cap(shown.fromHost)}>
            {(id) => <Select id={id} value={form.fromHost} onValueChange={(v) => retarget({ fromHost: v })} options={hostOptions} className="w-full" placeholder="Pick a host" />}
          </Field>
          <Field label="To host" description="…can use this one." error={cap(shown.toHost)}>
            {(id) => <Select id={id} value={form.toHost} onValueChange={(v) => retarget({ toHost: v })} options={hostOptions} className="w-full" placeholder="Pick a host" />}
          </Field>
        </div>

        <Field label="Name" hint={`${form.name.length}/${NAME_MAX}`} description={<>What {fromName} calls {toName}: <code className="font-mono">tf-forward {form.name || "name"}</code></>} error={cap(shown.name)}>
          {(id) => (
            <Input
              id={id}
              value={form.name}
              invalid={!!shown.name}
              onChange={(e) => patch({ name: e.target.value, nameEdited: true }, ["name"])}
              leading={<span className="shrink-0 font-mono text-xs text-mute-2">tf-forward</span>}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={NAME_MAX + 8}
            />
          )}
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 rounded-md bg-ink/[0.03] px-3 py-2.5 shadow-hairline">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-ink">Shell access</div>
              <div className="text-xs text-mute">Run any command on {toName}, or open a shell there, the way ssh does.</div>
            </div>
            <Switch checked={form.shell} onCheckedChange={(shell) => patch({ shell }, ["shell"])} label="Shell access" />
          </div>
          {shown.shell && <p className="text-xs font-semibold text-error">{cap(shown.shell)}</p>}
        </div>

        <Field label="Tools" hint="optional" description={`Commands that run on ${toName} when called by name on ${fromName}, like agent-browser opening its browser on your screen. They start in your home folder there.`} error={cap(shown.tools ?? toolError)}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5 empty:hidden">
                {form.tools.map((t) => (
                  <span key={t} className="inline-flex h-7 items-center gap-1 rounded-full bg-accent/14 pr-1 pl-2.5 font-mono text-xs font-semibold text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]">
                    {t}
                    <button
                      type="button"
                      aria-label={`Remove ${t}`}
                      className="grid size-5 place-items-center rounded-full pressable focus-ring hover:bg-ink/12"
                      onClick={() => {
                        setToolError(null);
                        patch({ tools: form.tools.filter((x) => x !== t) }, ["tools"]);
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
              <Input
                id={id}
                value={toolDraft}
                invalid={!!(shown.tools ?? toolError)}
                onChange={(e) => {
                  setToolDraft(e.target.value);
                  setToolError(null);
                }}
                onKeyDown={onToolKey}
                onBlur={() => toolDraft.trim() && addTool(toolDraft)}
                placeholder="Command name, then Enter"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                enterKeyHint="done"
                trailing={
                  toolDraft.trim() ? (
                    <Button size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => addTool(toolDraft)}>
                      Add
                    </Button>
                  ) : undefined
                }
              />
              {shadowedTools(form.tools).length > 0 && (
                <p role="status" className="text-xs font-semibold text-warn">
                  {shadowedTools(form.tools).map((t, i) => (
                    <span key={t}>
                      {i > 0 && ", "}
                      <code className="font-mono">{t}</code>
                    </span>
                  ))}{" "}
                  {shadowedTools(form.tools).length === 1 ? "is a program" : "are programs"} that {fromName} itself uses. Every agent TeleFlock starts there puts forwarded tools first on its PATH, so omp's own calls to {shadowedTools(form.tools).length === 1 ? "it" : "them"} would run on {toName}.
                </p>
              )}
              {form.tools.length > 0 && (
                <p className="text-2xs text-mute-2">
                  A tool that can run other commands through its options (<code className="font-mono">git -c</code>, <code className="font-mono">ssh</code>, <code className="font-mono">find -exec</code>, <code className="font-mono">npx</code>, editors, agent-browser's <code className="font-mono">eval</code> or <code className="font-mono">file://</code> pages) is as good as forwarding a shell.
                </p>
              )}
              {!form.tools.includes(SUGGESTED_TOOL) && (
                <button
                  type="button"
                  className="inline-flex h-7 w-fit items-center gap-1 rounded-full bg-ink/6 px-2.5 font-mono text-xs font-semibold text-mute pressable focus-ring hover:text-ink"
                  onClick={() => addTool(SUGGESTED_TOOL)}
                >
                  <Plus className="size-3" /> {SUGGESTED_TOOL}
                </button>
              )}
            </div>
          )}
        </Field>

        <Field label="Ports" hint="optional" description={`A connection to 127.0.0.1:<listen> on ${fromName} reaches 127.0.0.1:<target> on ${toName}: a headed Chrome's DevTools port, a dev server…`} error={cap(shown.ports)}>
          {() => (
            <div className="flex flex-col gap-2">
              {form.ports.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={p.listen}
                    inputMode="numeric"
                    invalid={!!shown.ports}
                    aria-label={`Listen port ${i + 1} on ${fromName}`}
                    placeholder="9222"
                    className="font-mono"
                    boxClassName="min-w-0 flex-1"
                    onChange={(e) => patch({ ports: form.ports.map((x, j) => (j === i ? { ...x, listen: e.target.value } : x)) }, ["ports"])}
                  />
                  <span className="text-mute-2" aria-hidden>
                    →
                  </span>
                  <Input
                    value={p.target}
                    inputMode="numeric"
                    invalid={!!shown.ports}
                    aria-label={`Target port ${i + 1} on ${toName}`}
                    placeholder="9222"
                    className="font-mono"
                    boxClassName="min-w-0 flex-1"
                    onChange={(e) => patch({ ports: form.ports.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) }, ["ports"])}
                  />
                  <IconButton label={`Remove port ${i + 1}`} size="sm" onClick={() => patch({ ports: form.ports.filter((_, j) => j !== i) }, ["ports"])}>
                    <X />
                  </IconButton>
                </div>
              ))}
              {count > 0 && (
                <p role="status" className="text-xs font-semibold text-warn">
                  While this forward is on, these ports are open to every account on {fromName}, like <code className="font-mono">ssh -L</code>. On Linux only your own user can connect; on macOS and Windows any local account can.
                </p>
              )}
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus />}
                className="w-fit"
                onClick={() => patch({ ports: [...form.ports, count === 0 ? suggestedPort() : { listen: "", target: "" }] }, ["ports"])}
              >
                Add port
              </Button>
            </div>
          )}
        </Field>

        <div className="flex items-center gap-3 rounded-md bg-ink/[0.03] px-3 py-2.5 shadow-hairline">
          <ShieldAlert className="size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-ink">On</div>
            <div className="text-xs text-mute">Off: nothing is offered, and a saved forward stays for later.</div>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(enabled) => patch({ enabled })} label="Forward is on" />
        </div>

        {otherError && <p className="text-xs font-semibold text-error">{otherError}</p>}
        {/* Enter in a field saves */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </ResponsiveDialog>
  );
}
