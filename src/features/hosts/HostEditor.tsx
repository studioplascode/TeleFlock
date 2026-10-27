import { ChevronDown, KeyRound, Server, ShieldCheck, Stethoscope, Trash2, Upload, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  BottomSheet,
  Button,
  cn,
  Dialog,
  DialogContent,
  Field,
  Input,
  SegmentedControl,
  Select,
  spring,
  Switch,
  Textarea,
  toast,
  useIsMobile,
} from "@/design";
import { core, draftKey, useDraftState, useHosts, useUi } from "@/core";
import type { DiagReport, HostKind, HostProfile, HostSecrets, SecretStatus, SshAuth, WslDistro } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { useAppInfo } from "./appInfo";
import { connectAndFollow } from "./ConnStatusCard";
import { CopyCommand, ExtLink } from "./CopyCommand";
import { Diagnostics } from "./Diagnostics";
import {
  AUTH_META,
  AUTH_METHODS,
  availableKinds,
  defaultHostName,
  HERDR_URL,
  HOST_COLORS,
  hostAccent,
  hostAuth,
  hostGroups,
  importsKeys,
  KEY_PATH_SUGGESTIONS,
  KIND_META,
  MAX_GROUP_LEN,
  newHostId,
  normalizeGroup,
  OMP_MIN_VERSION,
  OMP_URL,
  TAILSCALE_SSH_COMMAND,
} from "./kinds";
import { requestSetup } from "./setupFocus";

function blankProfile(kind: HostKind): HostProfile {
  return { id: "", name: "", kind, herdrSession: "default", autoConnect: true, port: 22, color: HOST_COLORS[0] };
}

/**
 * Sign-in secrets typed in this editor session. Memory only: never part of the persisted draft
 * (localStorage), sent with save / test and dropped when the editor closes.
 */
interface SecretInput {
  password: string;
  /** Imported or pasted private key (Android). */
  privateKey: string;
  /** File the key was imported from. */
  keyFile?: string;
  passphrase: string;
}

const NO_SECRETS: SecretInput = { password: "", privateKey: "", passphrase: "" };

/** Imported key files above this size are not private keys. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

type FieldKey = "name" | "address" | "user" | "port" | "keyPath" | "password" | "privateKey" | "herdrSession" | "relayPort";

/** Validation errors per field (empty when valid). `stored`: the secrets the app already keeps for this host. */
function validate(p: HostProfile, s: SecretInput, stored: SecretStatus | null): Partial<Record<FieldKey, string>> {
  const e: Partial<Record<FieldKey, string>> = {};
  if (!p.name.trim() && !defaultHostName(p)) e.name = "Give the host a name.";
  if (p.kind === "tailscaleSsh") {
    const auth = hostAuth(p);
    const a = p.address?.trim() ?? "";
    if (!a) e.address = auth === "tailscale" ? "MagicDNS name or tailnet IP, e.g. forge or 100.64.0.7." : "Host name or IP of the host.";
    else if (/\s|@|\//.test(a)) e.address = "Just the host name or IP (put the user in the User field).";
    if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) e.port = "1–65535";
    if (auth !== "tailscale" && !p.user?.trim()) e.user = "Your user name on the host.";
    if (auth === "key" && !importsKeys && !p.keyPath?.trim()) e.keyPath = "Path to your private key, e.g. ~/.ssh/id_ed25519.";
    if (auth === "key" && importsKeys && !s.privateKey.trim() && !stored?.privateKey) e.privateKey = "Import or paste your private key.";
    if (auth === "password" && !s.password && !stored?.password) e.password = "Enter the password.";
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(p.herdrSession)) e.herdrSession = "Letters, digits, dot, dash or underscore.";
  if (p.relayPort !== undefined && (!Number.isInteger(p.relayPort) || p.relayPort < 1024 || p.relayPort > 65535)) e.relayPort = "1024–65535";
  return e;
}

/** Remove empty optional strings so the saved profile is clean. */
function normalize(p: HostProfile): HostProfile {
  const out: HostProfile = { ...p, name: p.name.trim() || defaultHostName(p), herdrSession: p.herdrSession.trim() || "default" };
  if (p.kind !== "tailscaleSsh") {
    delete out.address;
    delete out.user;
    delete out.port;
    delete out.auth;
    delete out.keyPath;
  } else {
    out.address = p.address?.trim();
    if (!p.user?.trim()) delete out.user;
    else out.user = p.user.trim();
    const auth = hostAuth(p);
    if (auth === "tailscale") delete out.auth;
    const keyPath = p.keyPath?.trim();
    if (auth === "key" && !importsKeys && keyPath) out.keyPath = keyPath;
    else delete out.keyPath;
  }
  if (p.kind !== "wsl") delete out.distro;
  const group = normalizeGroup(p.group);
  if (group) out.group = group;
  else delete out.group;
  if (!out.id) out.id = newHostId(out.name);
  return out;
}

/** The secrets save / test send: what the sign-in method uses and the user typed (absent = keep the saved ones). */
function secretsPayload(p: HostProfile, s: SecretInput): HostSecrets | undefined {
  const auth = hostAuth(p);
  const out: HostSecrets = {};
  if (auth === "password" && s.password) out.password = s.password;
  if (auth === "key" && importsKeys && s.privateKey.trim()) out.privateKey = s.privateKey;
  if (auth === "key" && s.passphrase) out.passphrase = s.passphrase;
  return Object.keys(out).length > 0 ? out : undefined;
}

function WslPicker({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [distros, setDistros] = useState<WslDistro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    core.app("wsl.distros", {}).then(
      (r) => {
        if (!live) return;
        setDistros(r.distros);
        const def = r.distros.find((d) => d.isDefault) ?? r.distros[0];
        if (!value && def) onChange(def.name);
      },
      (err: unknown) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <Field label="WSL distro" error={error ?? undefined} description={distros && distros.length === 0 ? "No WSL distros found. Install one with `wsl --install`." : undefined}>
      {(id) => (
        <Select
          id={id}
          value={value}
          onValueChange={onChange}
          placeholder={distros ? "Pick a distro" : "Loading distros…"}
          disabled={!distros || distros.length === 0}
          className="w-full"
          options={(distros ?? []).map((d) => ({
            value: d.name,
            label: d.name,
            hint: `WSL ${d.version}${d.isDefault ? " · default" : ""} · ${d.running ? "running" : "stopped"}`,
          }))}
        />
      )}
    </Field>
  );
}

/** What must already be on the machine for a kind to work, said before the first failed connect. */
function Prerequisites({ kind, auth }: { kind: HostKind; auth: SshAuth }) {
  if (kind === "demo") return null;
  const tools = (
    <>
      <ExtLink href={HERDR_URL}>herdr</ExtLink> and <ExtLink href={OMP_URL}>omp</ExtLink> ≥ {OMP_MIN_VERSION}
    </>
  );
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-mute-2">
      <span className="font-bold text-mute">Before you start:</span>
      {kind === "tailscaleSsh" && auth !== "tailscale" ? (
        <span>
          On the host: an sshd that accepts your {auth === "key" ? "key" : "password"}, plus {tools}
        </span>
      ) : kind === "tailscaleSsh" ? (
        <>
          <span>On the host:</span>
          <span className="inline-flex min-w-0 items-center">
            <CopyCommand command={TAILSCALE_SSH_COMMAND} />,
          </span>
          <span>plus {tools}</span>
        </>
      ) : (
        <span>
          {tools} installed {kind === "wsl" ? "in the distro" : "on this machine"}
        </span>
      )}
    </p>
  );
}

/** Collapsed section: `label` toggles it; `aside` is shown next to the label while it is closed. */
function Advanced({ label = "Advanced", aside, defaultOpen = false, className = "grid gap-3 pt-3 sm:grid-cols-2", children }: { label?: string; aside?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1 rounded-xs text-xs font-bold text-mute hover:text-ink focus-ring" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {aside && !open && <span className="ml-1 font-semibold text-mute-2">{aside}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
            <div className={className}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const SAVED_PLACEHOLDER = "Saved · type to replace";

/**
 * "Advanced: authentication": how an SSH host signs in. Tailscale SSH stays the default; a private
 * key (a file on desktop, imported or pasted on Android) or a password are for hosts without it.
 * Secrets live in `secrets` (memory) until save; `stored` says which ones the app already keeps.
 */
function SignInSection({
  p,
  set,
  secrets,
  setSecret,
  stored,
  errors,
}: {
  p: HostProfile;
  set: (patch: Partial<HostProfile>) => void;
  secrets: SecretInput;
  setSecret: (patch: Partial<SecretInput>) => void;
  stored: SecretStatus | null;
  errors: Partial<Record<FieldKey, string>>;
}) {
  const auth = hostAuth(p);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importFile = (file: File | undefined) => {
    setImportError(null);
    if (!file) return;
    if (file.size > MAX_KEY_FILE_BYTES) {
      setImportError("That file is too large to be a private key.");
      return;
    }
    file.text().then(
      (text) => setSecret({ privateKey: text, keyFile: file.name }),
      () => setImportError("Couldn't read that file."),
    );
  };
  return (
    <Advanced label="Advanced: authentication" aside={AUTH_META[auth].label} defaultOpen={auth !== "tailscale"} className="flex flex-col gap-3 pt-3">
      <SegmentedControl<SshAuth>
        value={auth}
        onValueChange={(a) => set({ auth: a })}
        options={AUTH_METHODS.map((a) => {
          const M = AUTH_META[a];
          return { value: a, label: M.label, icon: <M.icon /> };
        })}
        size="sm"
        fill
        aria-label="Sign-in method"
      />
      <p className="text-xs text-mute">{AUTH_META[auth].blurb}</p>
      {auth === "key" && !importsKeys && (
        <Field label="Key file" hint="on this device" error={errors.keyPath}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <Input
                id={id}
                value={p.keyPath ?? ""}
                onChange={(e) => set({ keyPath: e.target.value })}
                placeholder={KEY_PATH_SUGGESTIONS[0]}
                className="font-mono"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                invalid={!!errors.keyPath}
              />
              <div className="flex flex-wrap gap-1.5" aria-label="Usual key files">
                {KEY_PATH_SUGGESTIONS.map((k) => {
                  const on = p.keyPath?.trim() === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ keyPath: k })}
                      className={cn(
                        "h-6 rounded-full px-2.5 font-mono text-2xs font-bold pressable focus-ring",
                        on ? "bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.05] text-mute hover:text-ink",
                      )}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Field>
      )}
      {auth === "key" && importsKeys && (
        <Field label="Private key" hint={stored?.privateKey && !secrets.privateKey ? "saved" : undefined} error={errors.privateKey ?? importError ?? undefined} description="Kept by TeleFlock; the file is not needed afterwards.">
          {(id) => (
            <div className="flex flex-col gap-2">
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  importFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {secrets.keyFile ? (
                <div className="well flex h-10 items-center gap-2 rounded-md px-3 text-sm">
                  <KeyRound className="size-4 shrink-0 text-mute-2" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{secrets.keyFile}</span>
                  <span className="text-xs text-mute-2">imported</span>
                  <button type="button" aria-label="Remove the imported key" onClick={() => setSecret({ privateKey: "", keyFile: undefined })} className="rounded-xs text-mute hover:text-ink focus-ring">
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <Textarea
                  id={id}
                  value={secrets.privateKey}
                  onChange={(e) => setSecret({ privateKey: e.target.value })}
                  placeholder={stored?.privateKey ? "A key is saved. Paste or import another to replace it." : "Paste the private key (-----BEGIN OPENSSH PRIVATE KEY-----…)"}
                  maxHeight={120}
                  className="font-mono text-2xs"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  invalid={!!errors.privateKey}
                />
              )}
              <Button variant="secondary" size="sm" icon={<Upload />} onClick={() => fileRef.current?.click()} className="self-start">
                Import key file
              </Button>
            </div>
          )}
        </Field>
      )}
      {auth === "key" && (
        <Field label="Passphrase" hint="if the key has one">
          {(id) => (
            <Input id={id} type="password" value={secrets.passphrase} onChange={(e) => setSecret({ passphrase: e.target.value })} placeholder={stored?.passphrase ? SAVED_PLACEHOLDER : undefined} autoComplete="new-password" />
          )}
        </Field>
      )}
      {auth === "password" && (
        <Field label="Password" hint={stored?.password ? "saved" : undefined} error={errors.password}>
          {(id) => (
            <Input
              id={id}
              type="password"
              value={secrets.password}
              onChange={(e) => setSecret({ password: e.target.value })}
              placeholder={stored?.password ? SAVED_PLACEHOLDER : undefined}
              autoComplete="new-password"
              invalid={!!errors.password}
            />
          )}
        </Field>
      )}
      {auth !== "tailscale" && (
        <p className="flex items-start gap-1.5 text-2xs text-mute-2">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          <span>
            Saved on this device only, readable by your user alone, and sent to nothing but this host. A host outside your tailnet shows its host key fingerprint for you to confirm on the first connect.
          </span>
        </p>
      )}
    </Advanced>
  );
}

function EditorBody({ initial, onDone, mobile }: { initial: HostProfile; onDone: () => void; mobile: boolean }) {
  const info = useAppInfo();
  const kinds = availableKinds(info?.capabilities);
  // persists per edited host ("new" for Add); untouched, it follows the saved profile
  const [p, setP, clearDraft] = useDraftState<HostProfile>(draftKey("host.editor", initial.id || "new"), initial);
  // sign-in secrets: memory only, never in the persisted draft
  const [secrets, setSecrets] = useState<SecretInput>(NO_SECRETS);
  const [stored, setStored] = useState<SecretStatus | null>(null);
  const [touched, setTouched] = useState(false);
  const [report, setReport] = useState<DiagReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validate(p, secrets, stored);
  const shown = touched ? errors : {};
  const valid = Object.keys(errors).length === 0;
  const editing = initial.id !== "";
  const auth = hostAuth(p);
  const set = (patch: Partial<HostProfile>) => {
    setP((prev) => ({ ...prev, ...patch }));
    setReport(null);
  };
  const setSecret = (patch: Partial<SecretInput>) => {
    setSecrets((prev) => ({ ...prev, ...patch }));
    setReport(null);
  };

  // Which secrets the app already keeps for this host (never the secrets themselves).
  useEffect(() => {
    if (!editing) return;
    let live = true;
    core.app("hosts.secretStatus", { hostId: initial.id }).then(
      (s) => live && setStored(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [editing, initial.id]);

  const test = () => {
    setTouched(true);
    if (!valid) return;
    setTesting(true);
    setReport(null);
    core
      .app("hosts.test", { ...normalize(p), secrets: secretsPayload(p, secrets) })
      .then(
        (r) => {
          setReport(r);
          haptic(r.steps.some((s) => s.status === "fail") ? "warning" : "success");
        },
        (err: unknown) => {
          setReport({ steps: [{ id: "error", label: "Test could not run", status: "fail", detail: errorHint(err) ? `${errorMessage(err)} — ${errorHint(err)}` : errorMessage(err) }] });
        },
      )
      .finally(() => setTesting(false));
  };

  const save = () => {
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    const profile = normalize(p);
    core
      .app("hosts.save", { ...profile, secrets: secretsPayload(p, secrets) })
      .then((saved) => {
        haptic("success");
        clearDraft();
        onDone();
        if (!editing) requestSetup(saved.id);
        if (saved.autoConnect) connectAndFollow(saved.id, saved.name);
        else toast({ title: editing ? `Saved ${saved.name}` : `Added ${saved.name}`, status: "done" });
      })
      .catch((err: unknown) => {
        haptic("warning");
        toast({ title: `Couldn't save: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
      })
      .finally(() => setSaving(false));
  };

  const remove = () => {
    core.app("hosts.remove", { hostId: initial.id }).then(
      () => {
        clearDraft();
        onDone();
        toast({ title: `Removed ${initial.name}` });
      },
      (err: unknown) => toast({ title: `Couldn't remove: ${errorMessage(err)}`, status: "error" }),
    );
  };

  const kindOptions = kinds.map((k) => {
    const M = KIND_META[k];
    return { value: k, label: M.short, icon: <M.icon /> };
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-2">
        <SegmentedControl<HostKind> value={p.kind} onValueChange={(kind) => set({ kind })} options={kindOptions} fill aria-label="Connection kind" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={p.kind} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="flex flex-col gap-1">
            <p className="text-xs text-mute">
              {p.kind === "tailscaleSsh" && auth !== "tailscale" ? `A herdr host reached over SSH, signing in with your ${auth === "key" ? "private key" : "password"}.` : KIND_META[p.kind].blurb}
            </p>
            <Prerequisites kind={p.kind} auth={auth} />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Name" hint={p.name.trim() ? undefined : defaultHostName(p) ? "from the address" : undefined} error={shown.name}>
          {(id) => <Input id={id} value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={defaultHostName(p) || "forge"} autoFocus={!mobile} invalid={!!shown.name} />}
        </Field>
        <Field label="Colour">
          {() => (
            <div className="flex h-10 items-center gap-1.5" role="radiogroup" aria-label="Host colour">
              {HOST_COLORS.map((c) => {
                const on = hostAccent(p.color) === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={c}
                    onClick={() => set({ color: c })}
                    className={cn("size-5 rounded-full pressable focus-ring transition-transform", on && "scale-125 shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_currentColor]")}
                    style={{ background: hostAccent(c), color: hostAccent(c) }}
                  />
                );
              })}
            </div>
          )}
        </Field>
      </div>

      <GroupField value={p.group ?? ""} onChange={(group) => set({ group })} />

      <AnimatePresence initial={false} mode="popLayout">
        {p.kind === "tailscaleSsh" && (
          <motion.div key="ts" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="overflow-hidden">
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[2fr_1fr_90px]">
                <Field label="Host" hint={auth === "tailscale" ? "MagicDNS or 100.x IP" : "host name or IP"} error={shown.address}>
                  {(id) => (
                    <Input id={id} value={p.address ?? ""} onChange={(e) => set({ address: e.target.value })} placeholder="forge" autoCapitalize="off" autoCorrect="off" spellCheck={false} invalid={!!shown.address} />
                  )}
                </Field>
                <Field label="User" hint={auth === "tailscale" ? "optional" : "required"} error={shown.user}>
                  {(id) => (
                    <Input
                      id={id}
                      value={p.user ?? ""}
                      onChange={(e) => set({ user: e.target.value })}
                      placeholder={auth === "tailscale" ? "tailnet default" : "you on the host"}
                      autoCapitalize="off"
                      spellCheck={false}
                      invalid={!!shown.user}
                    />
                  )}
                </Field>
                <Field label="Port" error={shown.port}>
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="numeric"
                      value={p.port == null ? "" : String(p.port)}
                      onChange={(e) => set({ port: e.target.value === "" ? undefined : Number(e.target.value) })}
                      placeholder="22"
                      invalid={!!shown.port}
                    />
                  )}
                </Field>
              </div>
              <SignInSection p={p} set={set} secrets={secrets} setSecret={setSecret} stored={stored} errors={shown} />
            </div>
          </motion.div>
        )}
        {p.kind === "wsl" && (
          <motion.div key="wsl" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="overflow-hidden">
            <WslPicker value={p.distro} onChange={(distro) => set({ distro })} />
          </motion.div>
        )}
      </AnimatePresence>

      <label className="flex items-center justify-between gap-3 rounded-md bg-white/[0.03] px-3 py-2.5 shadow-hairline">
        <span>
          <span className="block text-sm font-bold text-ink">Connect automatically</span>
          <span className="block text-xs text-mute">On app start and whenever the network comes back.</span>
        </span>
        <Switch checked={p.autoConnect} onCheckedChange={(autoConnect) => set({ autoConnect })} label="Connect automatically" />
      </label>

      {p.kind !== "demo" && (
        <Advanced>
          <Field label="herdr session" hint="default" error={shown.herdrSession}>
            {(id) => <Input id={id} value={p.herdrSession} onChange={(e) => set({ herdrSession: e.target.value })} spellCheck={false} invalid={!!shown.herdrSession} />}
          </Field>
          <Field label="Relay port" hint="47466" error={shown.relayPort} description="Only change this if 47466 is taken on the host.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={p.relayPort == null ? "" : String(p.relayPort)}
                onChange={(e) => set({ relayPort: e.target.value === "" ? undefined : Number(e.target.value) })}
                placeholder="47466"
                invalid={!!shown.relayPort}
              />
            )}
          </Field>
        </Advanced>
      )}

      <Diagnostics kind={p.kind} auth={auth} report={report} running={testing} />

      {/* The actions stay pinned to the bottom of the scrolling body: phone sheets ride above the keyboard (primary full-width in the thumb zone); short desktop windows keep them reachable. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border-t border-line pt-4",
          mobile ? "sticky bottom-0 z-raised -mx-4 -mb-3 bg-[#17171f] px-4 pt-2.5 pb-3 shadow-[0_-12px_24px_-12px_rgb(0_0_0/0.6)]" : "sticky bottom-0 z-raised bg-[#17171f]",
        )}
      >
        {editing && (
          <Button variant="danger" size="md" icon={<Trash2 />} onClick={remove} className={cn(mobile && "flex-1")}>
            Remove
          </Button>
        )}
        {!mobile && <div className="flex-1" />}
        <Button variant="secondary" icon={<Stethoscope />} onClick={test} loading={testing} className={cn(mobile && "flex-1")}>
          Test connection
        </Button>
        <Button type="submit" variant="primary" loading={saving} size={mobile ? "lg" : undefined} className={cn(mobile && "w-full")}>
          {editing ? "Save" : "Add host"}
        </Button>
      </div>
    </form>
  );
}

/** Host group: free text, existing groups offered as chips. Hosts in one group form a Dispatch Auto pool. */
function GroupField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const profiles = useHosts((s) => s.profiles);
  const groups = hostGroups(profiles);
  const current = normalizeGroup(value)?.toLowerCase();
  return (
    <Field label="Group" hint="optional" description="Hosts in the same group share work: Dispatch's Auto mode sends each task to the least busy one.">
      {(id) => (
        <div className="flex flex-col gap-2">
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. build farm" maxLength={MAX_GROUP_LEN + 8} autoCapitalize="off" spellCheck={false} />
          {groups.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Existing groups">
              {groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={g.toLowerCase() === current}
                  onClick={() => onChange(g.toLowerCase() === current ? "" : g)}
                  className={cn(
                    "h-6 rounded-full px-2.5 text-2xs font-bold pressable focus-ring",
                    g.toLowerCase() === current ? "bg-accent/18 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.05] text-mute hover:text-ink",
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

/** Add / edit a host. Opens for `useUi().dialog.kind === "hostEditor"` (with `hostId` to edit). */
export function HostEditor() {
  const { dialog, closeDialog } = useUi();
  const { profiles } = useHosts();
  const mobile = useIsMobile();
  const info = useAppInfo();
  const open = dialog?.kind === "hostEditor";
  const editId = dialog?.kind === "hostEditor" ? dialog.hostId : undefined;
  const existing = editId ? profiles.find((x) => x.id === editId) : undefined;
  const initial = existing ?? blankProfile(availableKinds(info?.capabilities)[0] ?? "tailscaleSsh");
  const title = existing ? `Edit ${existing.name}` : "Add a host";
  const description = "TeleFlock connects over Tailscale SSH (no keys or passwords), or to herdr on this machine.";
  const onOpenChange = (o: boolean) => {
    if (!o) closeDialog();
  };
  const body = open ? <EditorBody key={editId ?? "new"} initial={initial} onDone={closeDialog} mobile={mobile} /> : null;

  if (mobile) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} title={title} description={description} autoFocus={false}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} icon={<Server />} width={620}>
        {body}
      </DialogContent>
    </Dialog>
  );
}
