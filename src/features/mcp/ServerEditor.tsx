import { ArrowLeft, Blocks, Check, ExternalLink, FlaskConical, KeyRound, Library, Search, Sparkles, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { core, linkProps, toApiError } from "@/core";
import type { McpList, McpRegistryEntry, McpRegistryInput, McpScope, McpServer, McpServerDraft } from "@/core/gen";
import { Button, cn, SegmentedControl, Spinner, Switch, useIsMobile } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { RegistrySearch, TemplateGrid, useRegistrySearch } from "./Chooser";
import { EditorForm, RegistryInputs, TemplateInputs } from "./EditorForm";
import {
  applyRegistryInputs,
  applyTemplateInput,
  draftFromForm,
  emptyForm,
  errorField,
  type FieldKey,
  fieldMessage,
  type FormErrors,
  formFromDraft,
  type McpForm,
  plural,
  registryDefaults,
  registryInputError,
  scopeOf,
  uniqueName,
} from "./model";
import { Banner, DefinitionSummary, ErrorText, LetterMark, StatusChip, TestOutcome } from "./parts";
import type { RowTest } from "./ServerRow";
import { SignInPanel } from "./SignIn";
import type { McpTemplate } from "./templates";
import type { McpQuery } from "./useMcp";

export type EditorTab = "popular" | "registry" | "custom";

type Source = { kind: "template"; template: McpTemplate } | { kind: "registry"; entry: McpRegistryEntry };

export interface ServerEditorProps {
  hostId: string;
  hostName: string;
  home?: string;
  /** The page's project folder (absent: All projects). */
  cwd?: string;
  /** The live list (names in use; the saved server's status after saving). */
  list?: McpList;
  /** The server to edit (imported: shown read-only); absent: add one. */
  server?: McpServer;
  /** Where adding starts. */
  tab?: EditorTab;
  open: boolean;
  onOpenChange(open: boolean): void;
  mutate: McpQuery["mutate"];
  /** Switch state of `server` (with a change on its way) and the switch itself (imported servers). */
  enabled?: boolean;
  setEnabled: McpQuery["setEnabled"];
  /** A sign-in finished: read the list again. */
  onSignedIn(): void;
}

function SourceHeader({ source, onChange }: { source: Source; onChange(): void }) {
  const t = source.kind === "template" ? source.template : undefined;
  const e = source.kind === "registry" ? source.entry : undefined;
  const title = t?.title ?? e?.title ?? "";
  const homepage = t?.homepage ?? e?.homepage;
  const link = linkProps(homepage);
  return (
    <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
      {t ? <LetterMark mark={t.mark} color={t.color} ink={t.ink} /> : <LetterMark mark={title.slice(0, 2)} color="#7c6cf8" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-bold text-ink">{title}</span>
          {e && <span className="truncate font-mono text-2xs text-mute-2">{e.id}</span>}
        </span>
        <span className="line-clamp-2 text-2xs text-mute">{t?.description ?? e?.description}</span>
        {(t?.needs || link) && (
          <span className="flex flex-wrap items-center gap-x-3 text-2xs text-mute-2">
            {t?.needs && <span>{t.needs}</span>}
            {link && (
              <a {...link} className="inline-flex items-center gap-1 font-semibold text-accent-hi hover:text-ink">
                About <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onChange} className="shrink-0">
        Change
      </Button>
    </div>
  );
}

/** Required template inputs still blank (by input id), shown once the user tried to test or save. */
function templateInputErrors(t: McpTemplate | undefined, values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of t?.inputs ?? []) if (i.required && !(values[i.id] ?? "").trim()) out[i.id] = `Enter the ${i.label.toLowerCase()}`;
  return out;
}

function registryErrors(e: McpRegistryEntry | undefined, values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!e || e.server.transport !== "stdio") return out;
  for (const i of e.inputs) {
    const err = registryInputError(i, values[i.key] ?? "");
    if (err) out[i.key] = err;
  }
  return out;
}

/**
 * Add / edit an MCP server (dialog on desktop, full-height sheet on phones). Adding starts on a
 * chooser (Popular templates, Smithery registry, Custom); a saved HTTP server that wants a sign-in
 * offers it right here. Imported servers open read-only. Mount per opening.
 */
export function ServerEditor({ hostId, hostName, home, cwd, list, server, tab: initialTab, open, onOpenChange, mutate, enabled, setEnabled, onSignedIn }: ServerEditorProps) {
  const mobile = useIsMobile();
  const adding = !server;
  const imported = server?.origin === "imported";
  const startScope: McpScope = server ? (server.origin === "project" ? "project" : "user") : cwd ? "project" : "user";
  const [tab, setTab] = useState<EditorTab>(initialTab ?? "popular");
  const [source, setSource] = useState<Source | null>(null);
  const [form, setForm] = useState<McpForm>(() => (server && !imported ? formFromDraft(server.server, server.name, startScope) : emptyForm(startScope)));
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [hostError, setHostError] = useState<{ field: FieldKey | null; message: string; hint?: string } | null>(null);
  const [test, setTest] = useState<RowTest | null>(null);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<"edit" | "saved" | "signin">("edit");
  const [saved, setSaved] = useState<{ name: string; scope: McpScope; path: string } | null>(null);
  const search = useRegistrySearch(hostId);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const template = source?.kind === "template" ? source.template : undefined;
  const entry = source?.kind === "registry" ? source.entry : undefined;
  const choosing = adding && !source && tab !== "custom";
  const taken = (list?.servers ?? []).filter((s) => s.origin === form.scope).map((s) => s.name);
  const built = draftFromForm(form);
  const inputErrors = touched ? { ...templateInputErrors(template, inputs), ...registryErrors(entry, inputs) } : {};
  const errors: FormErrors = { ...(touched ? built.errors : {}) };
  if (hostError?.field) errors[hostError.field] = fieldMessage(hostError.message);

  // Bring a test's outcome into view when it arrives.
  const settled = test && test.startedAt === undefined;
  useEffect(() => {
    if (settled) outcomeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [settled]);

  const edit = (update: (f: McpForm) => McpForm) => {
    setForm(update);
    setHostError(null);
  };

  const pickTemplate = (t: McpTemplate) => {
    let f = formFromDraft(t.server, uniqueName(t.name, taken), form.scope);
    for (const input of t.inputs ?? []) f = applyTemplateInput(f, input, "", home);
    setForm(f);
    setInputs({});
    setSource({ kind: "template", template: t });
    setTouched(false);
    setHostError(null);
    setTest(null);
  };
  const pickEntry = (e: McpRegistryEntry) => {
    const values = registryDefaults(e.inputs);
    let f = formFromDraft(e.server, uniqueName(e.name, taken), form.scope);
    if (e.server.transport === "stdio" && e.inputs.length > 0) f = applyRegistryInputs(f, e.inputs, values);
    setForm(f);
    setInputs(values);
    setSource({ kind: "registry", entry: e });
    setTouched(false);
    setHostError(null);
    setTest(null);
  };
  const back = () => {
    setSource(null);
    setTest(null);
    setHostError(null);
    setTouched(false);
    if (tab === "custom") setForm(emptyForm(form.scope));
  };

  /** The draft to send, or null (with the problems shown) while the form isn't one. */
  const ready = (): McpServerDraft | null => {
    setTouched(true);
    const pending = { ...templateInputErrors(template, inputs), ...registryErrors(entry, inputs) };
    return built.draft && Object.keys(pending).length === 0 ? built.draft : null;
  };

  const runTest = () => {
    const draft = imported ? undefined : ready();
    if (!imported && !draft) return;
    setTest({ startedAt: Date.now() });
    setHostError(null);
    // Masked values of an edited server come from its saved definition.
    const ref = server ? { name: server.name, scope: scopeOf(server) } : { name: form.name.trim() || "new-server", scope: form.scope };
    core
      .host(hostId)
      .call("mcp.test", { ...(cwd ? { cwd } : {}), name: ref.name, scope: ref.scope, ...(draft ? { server: draft } : {}) })
      .then(
        (result) => setTest({ result }),
        (e: unknown) => {
          const err = toApiError(e);
          const field = errorField(err.message);
          if (field) {
            setHostError({ field, message: err.message, hint: err.hint });
            setTest(null);
          } else setTest({ error: [err.message, err.hint].filter(Boolean).join(" — ") });
        },
      );
  };

  const save = () => {
    const draft = ready();
    if (!draft) return;
    const name = form.name.trim();
    const scope = form.scope;
    setSaving(true);
    setHostError(null);
    mutate(
      (h) => h.call("mcp.save", { scope, ...(cwd ? { cwd } : {}), name, ...(server ? { previousName: server.name } : {}), server: draft }),
      server ? "Saved" : "Added",
    ).then(
      (changed) => {
        setSaving(false);
        const s = changed.list.servers.find((x) => x.name === name && x.origin === scope);
        const remote = draft.transport !== "stdio";
        const wantedSignIn = test?.result?.status === "needsAuth" || server?.status === "needsAuth" || s?.status === "needsAuth";
        if (s && remote && s.enabled && !s.signedIn && (adding || wantedSignIn)) {
          setSaved({ name, scope, path: s.path ?? (scope === "project" ? (changed.list.projectPath ?? "") : changed.list.userPath) });
          setStep("saved");
        } else onOpenChange(false);
      },
      (e: unknown) => {
        setSaving(false);
        const err = toApiError(e);
        setHostError({ field: errorField(err.message), message: err.message, hint: err.hint });
      },
    );
  };

  const savedServer = saved ? list?.servers.find((x) => x.name === saved.name && x.origin === saved.scope) : undefined;
  const testing = test?.startedAt !== undefined;

  // ---------------------------------------------------------------- body
  let title: ReactNode;
  let description: ReactNode;
  let body: ReactNode;
  let footer: ReactNode;
  const generalError = hostError && !hostError.field && <p className="text-xs font-semibold text-error">{[hostError.message, hostError.hint].filter(Boolean).join(" — ")}</p>;

  if (step === "signin" && saved) {
    title = `Sign in to ${saved.name}`;
    description = "omp signs in on the host; you approve it in this device's browser.";
    body = <SignInPanel hostId={hostId} target={{ name: saved.name, scope: saved.scope, cwd }} onDone={onSignedIn} onClose={() => onOpenChange(false)} />;
    footer = undefined;
  } else if (step === "saved" && saved) {
    const status = savedServer?.status ?? "checking";
    title = `Saved “${saved.name}”`;
    description = <span className="font-mono text-2xs">{tildify(saved.path, home)}</span>;
    body = (
      <div className="flex flex-col gap-3 pb-1">
        <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3.5 py-3 shadow-hairline">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-done/14 text-done">
            <Check className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-sm text-ink-2">omp sessions on {hostName} load it from now on; running ones pick it up as they reload.</p>
        </div>
        <div className="flex flex-col gap-2.5 rounded-lg well px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-mute">Status</span>
            <StatusChip status={status} tools={savedServer?.tools.length ?? 0} />
          </div>
          {status === "checking" && (
            <p className="flex items-center gap-2 text-xs text-mute">
              <Spinner size={13} /> Connecting the way an omp session would…
            </p>
          )}
          {status === "needsAuth" && <p className="text-xs text-ink-2">It wants a sign-in. omp opens it on the host; you approve it here, in this device's browser.</p>}
          {status === "connected" && savedServer && savedServer.tools.length > 0 && (
            <p className="text-xs text-mute">
              {plural(savedServer.tools.length, "tool")}: {savedServer.tools.slice(0, 6).map((t) => t.name).join(", ")}
              {savedServer.tools.length > 6 && "…"}
            </p>
          )}
          {status === "failed" && savedServer?.error && <ErrorText text={savedServer.error} />}
        </div>
      </div>
    );
    footer =
      status === "needsAuth" ? (
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Later
          </Button>
          <Button variant="primary" icon={<KeyRound />} onClick={() => setStep("signin")} className={mobile ? "flex-1" : undefined}>
            Sign in now
          </Button>
        </div>
      ) : (
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="primary" onClick={() => onOpenChange(false)} className={mobile ? "flex-1" : undefined}>
            Done
          </Button>
        </div>
      );
  } else if (imported && server) {
    title = server.name;
    description = `From ${server.sourceLabel ?? "another tool"}`;
    body = (
      <div className="flex flex-col gap-4 pb-1">
        <Banner tone="warn" title={`Defined in ${server.sourceLabel ?? "another tool"}`}>
          <span className="font-mono text-2xs">{tildify(server.path ?? "", home)}</span> — change it there. You can switch it off for omp here.
        </Banner>
        <label className="flex cursor-pointer items-center gap-3 rounded-md well px-3.5 py-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-bold">Used by omp</span>
            <span className="text-2xs text-mute-2">{enabled ? "omp sessions on this host start it" : "Switched off for omp (other tools still use it)"}</span>
          </span>
          <Switch checked={!!enabled} onCheckedChange={(v) => setEnabled(server, v)} label="Used by omp" />
        </label>
        <DefinitionSummary server={server.server} extra={server.extra} className="px-0.5" />
        <div ref={outcomeRef}>{test && <TestOutcome testing={test.startedAt} result={test.result} error={test.error} />}</div>
      </div>
    );
    footer = (
      <div className="flex w-full items-center justify-end gap-2">
        <Button variant="secondary" icon={<FlaskConical />} loading={testing} onClick={runTest} className={mobile ? "flex-1" : undefined}>
          Test
        </Button>
        <Button variant="primary" onClick={() => onOpenChange(false)} className={mobile ? "flex-1" : undefined}>
          Close
        </Button>
      </div>
    );
  } else {
    title = server ? `Edit “${server.name}”` : source ? `Add ${template?.title ?? entry?.title ?? "a server"}` : "Add an MCP server";
    description = server ? undefined : cwd && form.scope === "project" ? "Tools omp can use in this project's sessions." : `Tools omp can use in every session on ${hostName}.`;
    const sourceInputs =
      template?.inputs && template.inputs.length > 0 ? (
        <TemplateInputs
          inputs={template.inputs}
          values={inputs}
          errors={inputErrors}
          onChange={(input, value) => {
            setInputs((v) => ({ ...v, [input.id]: value }));
            edit((f) => applyTemplateInput(f, input, value, home));
          }}
        />
      ) : entry && entry.inputs.length > 0 ? (
        <RegistryInputs
          entry={entry}
          values={inputs}
          errors={inputErrors}
          onChange={(input: McpRegistryInput, value: string) => {
            const next = { ...inputs, [input.key]: value };
            setInputs(next);
            if (entry.server.transport === "stdio") edit((f) => applyRegistryInputs(f, entry.inputs, next));
          }}
        />
      ) : undefined;
    const formEl = (
      <div className="flex flex-col gap-5">
        {source && <SourceHeader source={source} onChange={back} />}
        {entry?.warnings.map((w) => (
          <Banner key={w} tone="warn" title={w} />
        ))}
        <EditorForm
          form={form}
          onChange={edit}
          errors={errors}
          home={home}
          scopeChoice={adding && cwd && list?.projectPath ? { projectPath: list.projectPath, userPath: list.userPath } : undefined}
          savedIn={server?.path}
          sourceInputs={sourceInputs}
          autoFocusName={!mobile && !source && !server}
        />
        <div ref={outcomeRef}>
          {test && (
            <TestOutcome testing={test.startedAt} result={test.result} error={test.error} needsAuthHint={server?.signedIn ? undefined : server ? "save, then sign in" : "add it, then sign in"} />
          )}
        </div>
      </div>
    );
    body = choosing ? (
      <div className="flex flex-col gap-4">
        {tab === "popular" ? <TemplateGrid onPick={pickTemplate} /> : <RegistrySearch search={search} onPick={pickEntry} autoFocus={!mobile} />}
      </div>
    ) : (
      formEl
    );
    if (adding && !source) {
      body = (
        <div className="flex flex-col gap-4">
          <SegmentedControl<EditorTab>
            value={tab}
            onValueChange={(t) => {
              setTab(t);
              setTest(null);
              setHostError(null);
            }}
            options={[
              { value: "popular", label: "Popular", icon: <Sparkles /> },
              { value: "registry", label: "Registry", icon: mobile ? <Search /> : <Library /> },
              { value: "custom", label: "Custom", icon: <SquarePen /> },
            ]}
            fill
            aria-label="Start from"
          />
          {body}
        </div>
      );
    }
    footer = choosing ? (
      mobile ? undefined : (
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-2xs text-mute-2">{tab === "popular" ? "Checked to work with omp. More in the registry." : "Results from smithery.ai, read through omp on the host."}</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      )
    ) : (
      <div className="flex w-full flex-col gap-2">
        {generalError}
        <div className="flex w-full items-center gap-2">
          {source && (
            <Button variant="ghost" icon={<ArrowLeft />} onClick={back} className={cn(mobile && "px-2.5")} aria-label="Back">
              {mobile ? undefined : "Back"}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {!mobile && (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            )}
            <Button variant="secondary" icon={<FlaskConical />} loading={testing} onClick={runTest}>
              Test
            </Button>
          </div>
          <Button variant="primary" loading={saving} onClick={save} className={mobile ? "flex-1" : undefined}>
            {server ? "Save" : "Add server"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={title} description={description} icon={step === "signin" ? <KeyRound /> : <Blocks />} width={760} tall footer={footer}>
      {body}
    </ResponsiveDialog>
  );
}
