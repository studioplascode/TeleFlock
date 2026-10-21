import { ChevronDown, Server, Stethoscope, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
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
  toast,
  useIsMobile,
} from "@/design";
import { core, draftKey, useDraftState, useHosts, useUi } from "@/core";
import type { DiagReport, HostKind, HostProfile, WslDistro } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { useAppInfo } from "./appInfo";
import { connectAndFollow } from "./ConnStatusCard";
import { Diagnostics } from "./Diagnostics";
import { availableKinds, HOST_COLORS, KIND_META, newHostId } from "./kinds";

function blankProfile(kind: HostKind): HostProfile {
  return { id: "", name: "", kind, herdrSession: "default", autoConnect: true, port: 22, color: HOST_COLORS[0] };
}

/** Validation errors per field (empty when valid). */
function validate(p: HostProfile): Partial<Record<"name" | "address" | "port" | "herdrSession" | "relayPort", string>> {
  const e: Partial<Record<"name" | "address" | "port" | "herdrSession" | "relayPort", string>> = {};
  if (!p.name.trim()) e.name = "Give the host a name.";
  if (p.kind === "tailscaleSsh") {
    const a = p.address?.trim() ?? "";
    if (!a) e.address = "MagicDNS name or tailnet IP, e.g. forge or 100.64.0.7.";
    else if (/\s|@|\//.test(a)) e.address = "Just the host name or IP (put the user in the User field).";
    if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) e.port = "1–65535";
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(p.herdrSession)) e.herdrSession = "Letters, digits, dot, dash or underscore.";
  if (p.relayPort !== undefined && (!Number.isInteger(p.relayPort) || p.relayPort < 1024 || p.relayPort > 65535)) e.relayPort = "1024–65535";
  return e;
}

/** Remove empty optional strings so the saved profile is clean. */
function normalize(p: HostProfile): HostProfile {
  const out: HostProfile = { ...p, name: p.name.trim(), herdrSession: p.herdrSession.trim() || "default" };
  if (p.kind !== "tailscaleSsh") {
    delete out.address;
    delete out.user;
    delete out.port;
  } else {
    out.address = p.address?.trim();
    if (!p.user?.trim()) delete out.user;
    else out.user = p.user.trim();
  }
  if (p.kind !== "wsl") delete out.distro;
  if (!out.id) out.id = newHostId(out.name);
  return out;
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

function Advanced({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1 rounded-xs text-xs font-bold text-mute hover:text-ink focus-ring" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Advanced
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
            <div className="grid gap-3 pt-3 sm:grid-cols-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EditorBody({ initial, onDone, mobile }: { initial: HostProfile; onDone: () => void; mobile: boolean }) {
  const info = useAppInfo();
  const kinds = availableKinds(info?.capabilities);
  // persists per edited host ("new" for Add); untouched, it follows the saved profile
  const [p, setP, clearDraft] = useDraftState<HostProfile>(draftKey("host.editor", initial.id || "new"), initial);
  const [touched, setTouched] = useState(false);
  const [report, setReport] = useState<DiagReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validate(p);
  const shown = touched ? errors : {};
  const valid = Object.keys(errors).length === 0;
  const editing = initial.id !== "";
  const set = (patch: Partial<HostProfile>) => {
    setP((prev) => ({ ...prev, ...patch }));
    setReport(null);
  };

  const test = () => {
    setTouched(true);
    if (!valid) return;
    setTesting(true);
    setReport(null);
    core
      .app("hosts.test", normalize(p))
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
      .app("hosts.save", profile)
      .then((saved) => {
        haptic("success");
        clearDraft();
        onDone();
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
          <motion.p key={p.kind} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="text-xs text-mute">
            {KIND_META[p.kind].blurb}
          </motion.p>
        </AnimatePresence>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Name" error={shown.name}>
          {(id) => <Input id={id} value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={p.kind === "demo" ? "Demo flock" : "forge"} autoFocus={!mobile} invalid={!!shown.name} />}
        </Field>
        <Field label="Colour">
          {() => (
            <div className="flex h-10 items-center gap-1.5" role="radiogroup" aria-label="Host colour">
              {HOST_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={p.color === c}
                  aria-label={c}
                  onClick={() => set({ color: c })}
                  className={cn("size-5 rounded-full pressable focus-ring transition-transform", p.color === c && "scale-125 shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_currentColor]")}
                  style={{ background: c, color: c }}
                />
              ))}
            </div>
          )}
        </Field>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {p.kind === "tailscaleSsh" && (
          <motion.div key="ts" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="overflow-hidden">
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_90px]">
              <Field label="Host" hint="MagicDNS or 100.x IP" error={shown.address}>
                {(id) => (
                  <Input id={id} value={p.address ?? ""} onChange={(e) => set({ address: e.target.value })} placeholder="forge" autoCapitalize="off" autoCorrect="off" spellCheck={false} invalid={!!shown.address} />
                )}
              </Field>
              <Field label="User" hint="optional">
                {(id) => <Input id={id} value={p.user ?? ""} onChange={(e) => set({ user: e.target.value })} placeholder="tailnet default" autoCapitalize="off" spellCheck={false} />}
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

      <Diagnostics kind={p.kind} report={report} running={testing} />

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
