import { ArrowLeft, Blocks, ExternalLink, FlaskConical, Library, Search, Sparkles, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { core, linkProps, toApiError } from "@/core";
import type { McpList, McpRegistryEntry, McpRegistryInput, McpScope, McpServer, McpServerDraft } from "@/core/gen";
import { Button, cn, SegmentedControl, Switch, useIsMobile } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { RegistrySearch, TemplateGrid, useRegistrySearch } from "./Chooser";
import { EditorForm, RegistryInputs, TemplateInputs } from "./EditorForm";
import {
  applyRegistryInputs,
  applyTemplateInput,
  draftFromForm,
  emptyForm,
  endpointKind,
  errorField,
  type FieldKey,
  fieldMessage,
  findSame,
  formEndpoint,
  type FormErrors,
  formFromDraft,
  type McpForm,
  registryDefaults,
  registryInputError,
  rowActions,
  type RowTest,
  scopeOf,
  serverKey,
  uniqueName,
} from "./model";
import { Banner, DefinitionSummary, LetterMark, SameServerNote, TestOutcome } from "./parts";
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
  /** The live list (names in use, servers already set up). */
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
  /** Show this server's row on the page (the sheet closes): the one just saved, or one already set up. */
  onReveal(key: string): void;
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
 * chooser (Popular templates, Smithery registry, Custom) that marks servers the host already has;
 * the form flags a URL / package that one already reaches. Saving closes the sheet on the saved
 * server's row, which shows how it connects (and offers Sign in when it wants one). Imported
 * servers open read-only. Mount per opening.
 */
export function ServerEditor({ hostId, hostName, home, cwd, list, server, tab: initialTab, open, onOpenChange, mutate, enabled, setEnabled, onReveal }: ServerEditorProps) {
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
  const search = useRegistrySearch(hostId);
  const outcomeRef = useRef<HTMLDivElement>(null);
  /** The row the sheet closed on (focus goes there). */
  const revealed = useRef<string | null>(null);

  const template = source?.kind === "template" ? source.template : undefined;
  const entry = source?.kind === "registry" ? source.entry : undefined;
  const choosing = adding && !source && tab !== "custom";
  const servers = list?.servers ?? [];
  const taken = servers.filter((s) => s.origin === form.scope).map((s) => s.name);
  const built = draftFromForm(form);
  const inputErrors = touched ? { ...templateInputErrors(template, inputs), ...registryErrors(entry, inputs) } : {};
  const errors: FormErrors = { ...(touched ? built.errors : {}) };
  if (hostError?.field) errors[hostError.field] = fieldMessage(hostError.message);

  // A server already set up that the form's URL / command line reaches too (not the one edited).
  const probe = formEndpoint(form);
  const same = imported || choosing ? undefined : findSame(probe, servers, server && serverKey(server))[0];

  const reveal = (key: string) => {
    revealed.current = key;
    onReveal(key);
    onOpenChange(false);
  };

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
      server ? `Saved “${name}”` : `Added “${name}”`,
      server ? "change" : "add",
    ).then(
      () => {
        setSaving(false);
        // Its row tells how it went: checking, then its status, with Sign in when it wants one.
        reveal(serverKey({ origin: scope, name }));
      },
      (e: unknown) => {
        setSaving(false);
        const err = toApiError(e);
        setHostError({ field: errorField(err.message), message: err.message, hint: err.hint });
      },
    );
  };

  const testing = test?.startedAt !== undefined;

  // ---------------------------------------------------------------- body
  let title: ReactNode;
  let description: ReactNode;
  let body: ReactNode;
  let footer: ReactNode;
  const generalError = hostError && !hostError.field && <p className="text-xs font-semibold text-error">{[hostError.message, hostError.hint].filter(Boolean).join(" — ")}</p>;

  if (imported && server) {
    const act = rowActions(server);
    title = server.name;
    description = `From ${server.sourceLabel ?? "another tool"}`;
    body = (
      <div className="flex flex-col gap-4 pb-1">
        <Banner tone="warn" title={`Defined in ${server.sourceLabel ?? "another tool"}`}>
          <span className="font-mono text-2xs">{tildify(server.path ?? "", home)}</span> — change it there.{act.toggle && " You can switch it off for omp here."}
        </Banner>
        <label className={cn("flex items-center gap-3 rounded-md well px-3.5 py-3", act.toggle && "cursor-pointer")}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-bold">Used by omp</span>
            <span className="text-2xs text-mute-2">
              {!act.toggle
                ? "No: a server of the same name takes precedence. Switching this one would switch that one too."
                : enabled
                  ? "omp sessions on this host start it"
                  : "Switched off for omp (other tools still use it)"}
            </span>
          </span>
          <Switch checked={act.toggle && !!enabled} disabled={!act.toggle} onCheckedChange={(v) => setEnabled(server, v)} label="Used by omp" />
        </label>
        <DefinitionSummary server={server.server} extra={server.extra} className="px-0.5" />
        <div ref={outcomeRef}>{test && <TestOutcome testing={test.startedAt} result={test.result} error={test.error} />}</div>
      </div>
    );
    footer = (
      <div className="flex w-full items-center justify-end gap-2">
        {act.test && (
          <Button variant="secondary" icon={<FlaskConical />} loading={testing} onClick={runTest} className={mobile ? "flex-1" : undefined}>
            Test
          </Button>
        )}
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
          sameNote={same && <SameServerNote server={same} what={endpointKind(probe)} onOpen={() => reveal(serverKey(same))} />}
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
        {tab === "popular" ? (
          <TemplateGrid servers={servers} onPick={pickTemplate} onOpen={(s) => reveal(serverKey(s))} />
        ) : (
          <RegistrySearch search={search} servers={servers} onPick={pickEntry} onOpen={(s) => reveal(serverKey(s))} autoFocus={!mobile} />
        )}
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
            {server ? "Save" : same ? "Add a second copy" : "Add server"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      icon={<Blocks />}
      width={760}
      tall
      footer={footer}
      onCloseAutoFocus={(e) => {
        const key = revealed.current;
        if (!key) return;
        // Focus goes to the row the sheet closed on, not back to the button that opened it.
        e.preventDefault();
        document.querySelector<HTMLElement>(`[data-mcp-row="${CSS.escape(key)}"] [aria-expanded]`)?.focus({ preventScroll: true });
      }}
    >
      {body}
    </ResponsiveDialog>
  );
}
