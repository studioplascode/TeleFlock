import { ChevronDown, Eye, EyeOff, FolderGit2, Globe, Globe2, Lock, LockOpen, Plus, TerminalSquare, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { McpRegistryEntry, McpRegistryInput } from "@/core/gen";
import { Button, cn, Field, IconButton, Input, SegmentedControl, Select, Switch } from "@/design";
import { tildify } from "@/features/workspace/shared/paths";
import { type FormErrors, hasAdvanced, joinArgs, type KvRow, kvRow, looksSecret, type McpForm, nameAdvice, NAME_MAX, splitArgs } from "./model";
import type { McpTemplateInput } from "./templates";

/** A password field with a show / hide toggle. A stored secret reads "Unchanged" until something is typed. */
function SecretInput({ value, onChange, stored, placeholder, label, leading, invalid, id }: { value: string; onChange(v: string): void; stored?: boolean; placeholder?: string; label: string; leading?: ReactNode; invalid?: boolean; id?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      id={id}
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={stored ? "Unchanged" : placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      invalid={invalid}
      leading={leading}
      className="font-mono text-xs"
      trailing={
        <IconButton size="sm" label={shown ? "Hide" : "Show"} onClick={() => setShown(!shown)} disabled={!value}>
          {shown ? <EyeOff /> : <Eye />}
        </IconButton>
      }
    />
  );
}

/** Env variables or headers: key, value (password field when secret), secret toggle, remove. */
function KeyValueRows({ rows, kind, onChange, error, extraAction }: { rows: KvRow[]; kind: "env" | "headers"; onChange(rows: KvRow[]): void; error?: string; extraAction?: ReactNode }) {
  const noun = kind === "env" ? "variable" : "header";
  const set = (id: number, p: Partial<KvRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)_auto] items-center gap-1.5">
          <Input
            value={r.key}
            onChange={(e) => {
              const key = e.target.value;
              // A stored secret belongs to its key: renamed, it has to be typed again.
              set(r.id, { key, stored: r.stored && key === r.key, secret: r.secretSet || r.stored ? r.secret : looksSecret(key) });
            }}
            placeholder={kind === "env" ? "NAME" : "Header"}
            aria-label={`${noun} name`}
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono text-xs"
          />
          {r.secret ? (
            <SecretInput
              value={r.value}
              onChange={(value) => set(r.id, { value })}
              stored={r.stored}
              label={`${r.key || noun} value`}
              placeholder={r.prefix ? "token" : "value"}
              leading={r.prefix ? <span className="shrink-0 font-mono text-2xs text-mute">{r.prefix.trim()}</span> : undefined}
            />
          ) : (
            <Input value={r.value} onChange={(e) => set(r.id, { value: e.target.value })} placeholder="value" aria-label={`${r.key || noun} value`} spellCheck={false} autoCapitalize="off" className="font-mono text-xs" />
          )}
          <div className="flex items-center">
            <IconButton
              size="sm"
              label={r.secret ? "Secret: hidden while typing, masked when listed" : "Mark as secret"}
              onClick={() => set(r.id, { secret: !r.secret, secretSet: true })}
              disabled={r.stored}
              className={r.secret ? "text-accent-hi" : undefined}
            >
              {r.secret ? <Lock /> : <LockOpen />}
            </IconButton>
            <IconButton size="sm" label={`Remove ${r.key || noun}`} onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
              <X />
            </IconButton>
          </div>
        </div>
      ))}
      {error && <p className="text-xs font-semibold text-error">{error}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => onChange([...rows, kvRow()])} className="-ml-1.5">
          Add {noun}
        </Button>
        {extraAction}
      </div>
    </div>
  );
}

/** Values a popular server asks for (folder, token), written into its definition as they are typed. */
export function TemplateInputs({ inputs, values, errors, onChange }: { inputs: readonly McpTemplateInput[]; values: Readonly<Record<string, string>>; errors: Readonly<Record<string, string>>; onChange(input: McpTemplateInput, value: string): void }) {
  return (
    <div className="flex flex-col gap-3.5">
      {inputs.map((input) => (
        <Field key={input.id} label={input.label} hint={input.required ? "required" : undefined} description={input.description} error={errors[input.id]}>
          {(id) =>
            input.secret ? (
              <SecretInput id={id} value={values[input.id] ?? ""} onChange={(v) => onChange(input, v)} label={input.label} placeholder={input.placeholder} invalid={!!errors[input.id]} />
            ) : (
              <Input
                id={id}
                value={values[input.id] ?? ""}
                onChange={(e) => onChange(input, e.target.value)}
                placeholder={input.placeholder}
                invalid={!!errors[input.id]}
                spellCheck={false}
                autoCapitalize="off"
                className={cn(input.path && "font-mono text-xs")}
              />
            )
          }
        </Field>
      ))}
    </div>
  );
}

/** A registry server's settings: fields for a local one (they go into `--config`), a list for a hosted one. */
export function RegistryInputs({ entry, values, errors, onChange }: { entry: McpRegistryEntry; values: Readonly<Record<string, string>>; errors: Readonly<Record<string, string>>; onChange(input: McpRegistryInput, value: string): void }) {
  if (entry.server.transport !== "stdio") {
    return (
      <div className="flex flex-col gap-1.5 rounded-md well px-3 py-2.5">
        <p className="text-xs text-ink-2">Smithery asks for these settings when you sign in to it:</p>
        <ul className="flex flex-col gap-0.5">
          {entry.inputs.map((i) => (
            <li key={i.key} className="text-2xs text-mute">
              <span className="font-semibold text-ink-2">{i.label}</span>
              {i.required && " (required)"}
              {i.description && ` — ${i.description}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {entry.inputs.map((input) => {
        const v = values[input.key] ?? "";
        const err = errors[input.key];
        if (input.kind === "boolean") {
          return (
            <label key={input.key} className="flex cursor-pointer items-center gap-3 rounded-md well px-3.5 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-bold">{input.label}</span>
                {input.description && <span className="text-2xs text-mute-2">{input.description}</span>}
              </span>
              <Switch checked={v === "true"} onCheckedChange={(on) => onChange(input, on ? "true" : "false")} label={input.label} />
            </label>
          );
        }
        return (
          <Field key={input.key} label={input.label} hint={input.required ? "required" : undefined} description={input.description} error={err}>
            {(id) =>
              input.choices.length > 0 ? (
                <Select id={id} value={v || undefined} onValueChange={(x) => onChange(input, x)} options={input.choices.map((c) => ({ value: c, label: c }))} className="w-full" aria-label={input.label} />
              ) : input.secret ? (
                <SecretInput id={id} value={v} onChange={(x) => onChange(input, x)} label={input.label} invalid={!!err} />
              ) : (
                <Input id={id} value={v} onChange={(e) => onChange(input, e.target.value)} inputMode={input.kind === "number" ? "decimal" : undefined} invalid={!!err} spellCheck={false} autoCapitalize="off" />
              )
            }
          </Field>
        );
      })}
    </div>
  );
}

export interface EditorFormProps {
  form: McpForm;
  onChange(update: (f: McpForm) => McpForm): void;
  errors: FormErrors;
  /** Adding while a project is selected: offer both files. */
  scopeChoice?: { projectPath: string; userPath: string };
  /** Editing: where the server is saved. */
  savedIn?: string;
  home?: string;
  /** Settings of the picked template / registry server, above the definition. */
  sourceInputs?: ReactNode;
  /** Under the URL / the command line: the server they already reach (`SameServerNote`). */
  sameNote?: ReactNode;
  autoFocusName?: boolean;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="kicker">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Name, scope, transport and the definition's fields; Advanced holds timeout, SSE and the OAuth app. */
export function EditorForm({ form: f, onChange, errors, scopeChoice, savedIn, home, sourceInputs, sameNote, autoFocusName }: EditorFormProps) {
  const [advanced, setAdvanced] = useState(() => hasAdvanced(f));
  const patch = (p: Partial<McpForm>) => onChange((x) => ({ ...x, ...p }));
  const patchOAuth = (p: Partial<McpForm["oauth"]>) => onChange((x) => ({ ...x, oauth: { ...x.oauth, ...p } }));
  const stdio = f.transport === "stdio";
  const advice = !errors.name ? nameAdvice(f.name.trim()) : null;
  const hasBearer = f.headers.some((h) => h.key.toLowerCase() === "authorization");
  return (
    <div className="flex flex-col gap-6 pb-1">
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="omp's tools are named after it" error={errors.name} description={advice}>
          {(id) => (
            <Input
              id={id}
              value={f.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="my-server"
              maxLength={NAME_MAX}
              invalid={!!errors.name}
              autoFocus={autoFocusName}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}
        </Field>
        {scopeChoice && (
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs font-bold tracking-[0.02em] text-mute">Scope</span>
            <SegmentedControl<"project" | "user">
              value={f.scope}
              onValueChange={(scope) => patch({ scope })}
              options={[
                { value: "project", label: "This project", icon: <FolderGit2 /> },
                { value: "user", label: "All projects", icon: <Globe2 /> },
              ]}
              fill
              aria-label="Scope"
            />
            <p className="truncate font-mono text-2xs text-mute-2">Saved in {tildify(f.scope === "project" ? scopeChoice.projectPath : scopeChoice.userPath, home)}</p>
          </div>
        )}
        {savedIn && <p className="-mt-1 truncate font-mono text-2xs text-mute-2">Saved in {tildify(savedIn, home)}</p>}
      </div>

      {sourceInputs && <Section title="Settings">{sourceInputs}</Section>}

      <Section title="Connection">
        <SegmentedControl<"stdio" | "url">
          value={stdio ? "stdio" : "url"}
          onValueChange={(v) => patch({ transport: v === "stdio" ? "stdio" : f.transport === "sse" ? "sse" : "http" })}
          options={[
            { value: "stdio", label: "Command", icon: <TerminalSquare /> },
            { value: "url", label: "URL", icon: <Globe /> },
          ]}
          fill
          aria-label="How omp reaches the server"
        />
        <p className="text-xs text-mute">{stdio ? "omp starts a program on the host and talks to it over stdin/stdout." : "omp connects to a server over HTTP (Streamable HTTP, or legacy SSE under Advanced)."}</p>
        {stdio ? (
          <div className="flex flex-col gap-3.5">
            <Field label="Command" error={errors.command} description="Found on the host's PATH, or an absolute path.">
              {(id) => (
                <Input
                  id={id}
                  value={f.command}
                  onChange={(e) => patch({ command: e.target.value })}
                  onPaste={(e) => {
                    // A pasted command line splits into the program and its arguments.
                    const text = e.clipboardData.getData("text").trim();
                    if (f.command.trim() || f.argsText.trim() || !/\s/.test(text)) return;
                    const { args, error } = splitArgs(text);
                    if (error || args.length < 2) return;
                    e.preventDefault();
                    patch({ command: args[0] ?? "", argsText: joinArgs(args.slice(1)) });
                  }}
                  placeholder="npx"
                  invalid={!!errors.command}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="font-mono text-xs"
                />
              )}
            </Field>
            <div className="flex flex-col gap-2">
              <Field label="Arguments" error={errors.args} description="Separated by spaces; quote one that contains spaces.">
                {(id) => (
                  <Input
                    id={id}
                    value={f.argsText}
                    onChange={(e) => patch({ argsText: e.target.value })}
                    placeholder="-y @modelcontextprotocol/server-memory"
                    invalid={!!errors.args}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono text-xs"
                  />
                )}
              </Field>
              {sameNote}
            </div>
            <Field label="Working folder" hint="optional">
              {(id) => (
                <Input
                  id={id}
                  value={f.cwd}
                  onChange={(e) => patch({ cwd: e.target.value })}
                  placeholder="The session's folder"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="font-mono text-xs"
                />
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-2xs font-bold tracking-[0.02em] text-mute">Environment</span>
              <KeyValueRows rows={f.env} kind="env" onChange={(env) => patch({ env })} error={errors.env} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-2">
              <Field label="URL" error={errors.url}>
                {(id) => (
                  <Input
                    id={id}
                    value={f.url}
                    onChange={(e) => patch({ url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                    invalid={!!errors.url}
                    inputMode="url"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono text-xs"
                  />
                )}
              </Field>
              {sameNote}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-2xs font-bold tracking-[0.02em] text-mute">Headers</span>
              <KeyValueRows
                rows={f.headers}
                kind="headers"
                onChange={(headers) => patch({ headers })}
                error={errors.headers}
                extraAction={
                  !hasBearer && (
                    <Button size="sm" variant="ghost" icon={<Lock />} onClick={() => patch({ headers: [...f.headers, kvRow({ key: "Authorization", secret: true, prefix: "Bearer " })] })}>
                      Add bearer token
                    </Button>
                  )
                }
              />
            </div>
          </div>
        )}
      </Section>

      <section className="flex flex-col gap-3">
        <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} className="flex items-center gap-1.5 self-start rounded-xs kicker focus-ring hover:text-ink">
          <ChevronDown className={cn("size-3.5 transition-transform", !advanced && "-rotate-90")} />
          Advanced
        </button>
        {advanced && (
          <div className="flex flex-col gap-3.5">
            <Field label="Timeout" hint="ms per request" error={errors.timeout} description="omp waits 30 000 ms by default; 0 waits forever.">
              {(id) => <Input id={id} value={f.timeoutMs} onChange={(e) => patch({ timeoutMs: e.target.value })} placeholder="30000" inputMode="numeric" invalid={!!errors.timeout} className="font-mono text-xs" />}
            </Field>
            {!stdio && (
              <>
                <label className="flex cursor-pointer items-center gap-3 rounded-md well px-3.5 py-2.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-bold">Legacy SSE transport</span>
                    <span className="text-2xs text-mute-2">For older servers that only speak HTTP + Server-Sent Events.</span>
                  </span>
                  <Switch checked={f.transport === "sse"} onCheckedChange={(on) => patch({ transport: on ? "sse" : "http" })} label="Legacy SSE transport" />
                </label>
                <div className="flex flex-col gap-2.5">
                  <div>
                    <span className="text-2xs font-bold tracking-[0.02em] text-mute">OAuth app</span>
                    <p className="text-xs text-mute-2">Only for providers that need a pre-registered app; omp registers itself otherwise.</p>
                  </div>
                  {errors.oauth && <p className="text-xs font-semibold text-error">{errors.oauth}</p>}
                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                    <Input value={f.oauth.clientId} onChange={(e) => patchOAuth({ clientId: e.target.value })} placeholder="Client ID" aria-label="OAuth client ID" spellCheck={false} autoCapitalize="off" className="font-mono text-xs" />
                    <SecretInput value={f.oauth.clientSecret} onChange={(clientSecret) => patchOAuth({ clientSecret })} stored={f.oauth.clientSecretStored} label="OAuth client secret" placeholder="Client secret" />
                    <Input value={f.oauth.scope} onChange={(e) => patchOAuth({ scope: e.target.value })} placeholder="Scopes (space-separated)" aria-label="OAuth scopes" spellCheck={false} autoCapitalize="off" className="font-mono text-xs" />
                    <Input value={f.oauth.callbackPort} onChange={(e) => patchOAuth({ callbackPort: e.target.value })} placeholder="Callback port (3000)" aria-label="OAuth callback port" inputMode="numeric" className="font-mono text-xs" />
                    <Input
                      value={f.oauth.redirectUri}
                      onChange={(e) => patchOAuth({ redirectUri: e.target.value })}
                      placeholder="Redirect URI (http://localhost:3000/callback)"
                      aria-label="OAuth redirect URI"
                      spellCheck={false}
                      autoCapitalize="off"
                      boxClassName="md:col-span-2"
                      className="font-mono text-xs"
                    />
                  </div>
                  {f.oauth.clientSecretStored && (
                    <button type="button" onClick={() => patchOAuth({ clientSecretStored: false, clientSecret: "" })} className="self-start rounded-xs text-2xs font-bold text-mute hover:text-ink focus-ring">
                      Forget the stored client secret
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
