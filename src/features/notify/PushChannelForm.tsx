import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button, cn, Field, IconButton, Input, Select, Switch, toast } from "@/design";
import { core } from "@/core";
import type { NotifyConfig, NotifyKind, PushChannel, PushChannelSave, PushKind, PushWhen } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { closeSheet } from "@/features/shell/sheets";
import { Ticks } from "@/features/shell/Ticks";
import { choiceOn, DEFAULT_PUSH_KINDS, PUSH_KIND_CHOICES, PUSH_KIND_LABEL, PUSH_WHEN_LABEL, toggleChoice } from "./alerts";

type Secret = "url" | "token" | "user" | "secret";

interface FieldSpec {
  key: Secret;
  label: string;
  required: boolean;
  placeholder: string;
  description?: string;
}

/** The secret fields each channel kind takes, in order. */
const FIELDS: Record<PushKind, FieldSpec[]> = {
  ntfy: [
    { key: "url", label: "Topic URL", required: true, placeholder: "https://ntfy.sh/your-topic", description: "Anyone who knows a public topic can read it: pick a long, random name." },
    { key: "token", label: "Access token", required: false, placeholder: "tk_…", description: "Only for a protected topic or your own server." },
  ],
  pushover: [
    { key: "user", label: "User key", required: true, placeholder: "30-character key from your Pushover dashboard" },
    { key: "token", label: "Application token", required: true, placeholder: "API token of an application you created at pushover.net" },
  ],
  webhook: [
    { key: "url", label: "URL", required: true, placeholder: "https://example.com/teleflock", description: "TeleFlock POSTs a JSON event here." },
    { key: "secret", label: "Signing secret", required: false, placeholder: "Optional" },
  ],
};

const KIND_OPTIONS = (Object.keys(PUSH_KIND_LABEL) as PushKind[]).map((k) => ({ value: k, label: PUSH_KIND_LABEL[k] }));
const WHEN_OPTIONS = (Object.keys(PUSH_WHEN_LABEL) as PushWhen[]).map((w) => ({ value: w, label: PUSH_WHEN_LABEL[w] }));

/** A secret input: password-typed, empty with "saved" when the host keeps a value (empty = keep), Clear deletes it. */
function SecretInput({ spec, value, saved, cleared, error, onChange, onClear }: { spec: FieldSpec; value: string; saved: boolean; cleared: boolean; error?: string; onChange: (v: string) => void; onClear: (on: boolean) => void }) {
  const [shown, setShown] = useState(false);
  const keep = saved && !cleared;
  return (
    <Field
      label={spec.label}
      hint={spec.required ? "required" : "optional"}
      error={error}
      description={
        cleared ? (
          <>
            Will be removed when you save.{" "}
            <button type="button" className="font-bold text-accent-ink underline focus-ring" onClick={() => onClear(false)}>
              Keep it
            </button>
          </>
        ) : (
          <>
            {keep && (
              <>
                Saved on the host, never shown again. Type to replace it
                {!spec.required && (
                  <>
                    {" or "}
                    <button type="button" className="font-bold text-accent-ink underline focus-ring" onClick={() => onClear(true)}>
                      clear it
                    </button>
                  </>
                )}
                .{" "}
              </>
            )}
            {spec.description}
          </>
        )
      }
    >
      {(id) => (
        <Input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={cleared ? "" : value}
          disabled={cleared}
          invalid={!!error}
          placeholder={keep ? "••••••••  saved" : spec.placeholder}
          onChange={(e) => onChange(e.target.value)}
          trailing={
            <IconButton label={shown ? `Hide ${spec.label}` : `Show ${spec.label}`} size="sm" onClick={() => setShown((s) => !s)}>
              {shown ? <EyeOff /> : <Eye />}
            </IconButton>
          }
        />
      )}
    </Field>
  );
}

/**
 * Add or edit one push channel of a host (`notify.saveChannel`). A secret you leave empty stays as
 * stored on the host; "Clear" deletes it. The host validates what it needs and says so in its error.
 */
export function PushChannelForm({ hostId, initial, onSaved }: { hostId: string; initial?: PushChannel; onSaved: (config: NotifyConfig) => void }) {
  const [kind, setKind] = useState<PushKind>(initial?.kind ?? "ntfy");
  const [name, setName] = useState(initial?.name ?? "");
  const [when, setWhen] = useState<PushWhen>(initial?.when ?? "unseen");
  const [kinds, setKinds] = useState<NotifyKind[]>(initial ? [...initial.kinds] : [...DEFAULT_PUSH_KINDS]);
  const [priv, setPriv] = useState(initial?.private ?? false);
  const [values, setValues] = useState<Record<Secret, string>>({ url: "", token: "", user: "", secret: "" });
  const [cleared, setCleared] = useState<Record<Secret, boolean>>({ url: false, token: false, user: false, secret: false });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const specs = FIELDS[kind];
  const isSaved = (k: Secret) => initial?.saved.includes(k) === true;
  const missing = (s: FieldSpec) => s.required && touched && !(values[s.key].trim() !== "" || (isSaved(s.key) && !cleared[s.key]));
  const nameError = touched && !name.trim() ? "Give the channel a name." : undefined;

  const submit = () => {
    setTouched(true);
    if (!name.trim() || specs.some((s) => s.required && !(values[s.key].trim() !== "" || (isSaved(s.key) && !cleared[s.key])))) return;
    const save: PushChannelSave = { ...(initial ? { id: initial.id } : {}), kind, name: name.trim(), enabled: initial?.enabled ?? true, when, kinds, private: priv };
    for (const s of specs) {
      if (cleared[s.key]) save[s.key] = "";
      else if (values[s.key].trim() !== "") save[s.key] = values[s.key].trim();
    }
    setSaving(true);
    core
      .host(hostId)
      .call("notify.saveChannel", save)
      .then(
        (config) => {
          haptic("success");
          toast({ title: initial ? `Saved “${save.name}”` : `Added “${save.name}”`, status: "done" });
          closeSheet();
          onSaved(config);
        },
        (err: unknown) => {
          haptic("warning");
          toast({ title: `Couldn't save the channel: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
        },
      )
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
        <Field label="Service" description={initial ? "A channel keeps its service; add another to switch." : undefined}>
          {(id) => <Select id={id} className="w-full" value={kind} disabled={initial !== undefined} onValueChange={(v) => setKind(v as PushKind)} options={KIND_OPTIONS} />}
        </Field>
        <Field label="Name" error={nameError}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "pushover" ? "Pushover on my phone" : kind === "webhook" ? "Team chat bridge" : "ntfy on my phone"} autoFocus invalid={!!nameError} />}
        </Field>
      </div>

      {specs.map((s) => (
        <SecretInput
          key={`${kind}-${s.key}`}
          spec={s}
          value={values[s.key]}
          saved={isSaved(s.key)}
          cleared={cleared[s.key]}
          error={missing(s) ? `${s.label} is required.` : undefined}
          onChange={(v) => setValues((p) => ({ ...p, [s.key]: v }))}
          onClear={(on) => setCleared((p) => ({ ...p, [s.key]: on }))}
        />
      ))}
      {kind === "webhook" && (
        <p className="-mt-2 text-xs text-mute">
          <Ticks text="With a signing secret every request carries `X-TeleFlock-Timestamp` and `X-TeleFlock-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<body>` keyed with the secret. Check it and reject old timestamps." />
        </p>
      )}

      <Field label="Send when">{(id) => <Select id={id} className="w-full" value={when} onValueChange={(v) => setWhen(v as PushWhen)} options={WHEN_OPTIONS} />}</Field>

      <div>
        <div className="mb-1.5 text-sm font-bold text-ink">Send for</div>
        <div className="flex flex-wrap gap-1.5">
          {PUSH_KIND_CHOICES.map((c) => {
            const on = choiceOn(kinds, c);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => setKinds((k) => toggleChoice(k, c, !on))}
                className={cn(
                  "h-8 rounded-full px-3 text-xs font-bold transition-colors touch-hit focus-ring",
                  on ? "bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5)]" : "bg-white/6 text-mute shadow-hairline hover:text-ink",
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md bg-white/[0.03] px-3 py-2.5 shadow-hairline">
        <span>
          <span className="block text-sm font-bold text-ink">Hide details</span>
          <span className="block text-xs text-mute">Only the agent's name and what happened leave the host: no prompt, file or command text.</span>
        </span>
        <Switch checked={priv} onCheckedChange={setPriv} label="Hide details" />
      </label>

      <p className="text-xs text-mute">Secrets stay on the host, in a file only its owner can read, and are never shown again.</p>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={closeSheet}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {initial ? "Save channel" : "Add channel"}
        </Button>
      </div>
    </form>
  );
}
