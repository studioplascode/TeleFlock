import { Download, Mic, RefreshCw, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { core, toApiError } from "@/core";
import type { AppMethods, DictationMicrophone, DictationModel, DictationState } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Badge, Button, cn, IconButton, isAndroid, isTauri, SegmentedControl, Select, type SelectOption, Skeleton, toast } from "@/design";
import { bringIntoView } from "@/features/refusal/focus";
import { hasWebSpeech } from "@/features/session/composer/useDictation";
import { Row, Section } from "@/features/settings/parts";
import { RamblerRows } from "@/features/settings/RamblerSettings";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { downloadPercent, isSlow, languageNote, languageOptions, onDevicePick, takeoverAfterRemoving } from "./models";
import { applyDictationState, startDictation, useDictationModels } from "./store";

type StateMethod = "dictation.install" | "dictation.cancelInstall" | "dictation.remove" | "dictation.select" | "dictation.setLanguage" | "dictation.setMicrophone";

/** Runs a `dictation.*` call that answers with the new state; a failure is a toast. */
async function change<M extends StateMethod>(method: M, params: AppMethods[M]["params"], failed: string): Promise<boolean> {
  try {
    applyDictationState(await core.app(method, params));
    return true;
  } catch (e) {
    const err = toApiError(e);
    toast({ title: failed, description: [err.message, err.hint].filter(Boolean).join(". "), status: "error" });
    return false;
  }
}

/**
 * Settings → Dictation: which speech recognition listens when you tap a composer's mic (the system's, or a speech
 * model running on this device), the models (download with progress, cancel, resume, delete, use), the language
 * and the microphone, then Rambler's rows. An app core without speech models (Android, older) says what listens.
 */
export function DictationSettings({ index }: { index: number }) {
  const state = useDictationModels((s) => s.state);
  const missing = useDictationModels((s) => s.missing);
  const focus = useDictationModels((s) => s.focus);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => startDictation(), []);
  // A composer's "Open settings" (no speech model yet) brings the card into view.
  useEffect(() => {
    if (!focus) return;
    bringIntoView(card.current);
    useDictationModels.setState({ focus: false });
  }, [focus]);
  return (
    <div id="settings-dictation" ref={card} className="scroll-mt-4 max-md:scroll-mt-16">
      <Section index={index} icon={<Mic />} title="Dictation" description="Talking to the composers: what turns your speech into text, and Rambler.">
        {state?.supported ? <DeviceRows state={state} /> : <SystemRows missing={state ? { code: "unsupported", message: "" } : missing} />}
        <RamblerRows />
      </Section>
    </div>
  );
}

/** This app core has no speech models: what listens instead. `missing` null: not known yet. */
function SystemRows({ missing }: { missing: { code: string; message: string } | null }) {
  if (!missing) {
    return (
      <Row label="Speech recognition" description={<Skeleton className="mt-1 h-3 w-64" />}>
        {null}
      </Row>
    );
  }
  const android = isTauri() && isAndroid;
  const web = hasWebSpeech();
  const listens = android
    ? "Android's speech recognizer turns what you say into text: Google's, unless you chose another in Android's settings."
    : web
      ? "This browser's speech recognition turns what you say into text (Chrome and Edge send your voice to Google or Microsoft for it)."
      : "This browser has no speech recognition, so the composers show no mic.";
  const models =
    missing.code === "unknown_method"
      ? "Speech models that run on the device came with TeleFlock 0.9.0: update this app core to use them."
      : android
        ? "Speech models that run on the device itself are in the desktop app."
        : "Speech models that run on the device itself are in the desktop app.";
  return (
    <Row label="Speech recognition" description={`${listens} ${models}`}>
      {null}
    </Row>
  );
}

function DeviceRows({ state }: { state: DictationState }) {
  const chosen = state.models.find((m) => m.id === state.selected) ?? null;
  return (
    <>
      <EngineRow state={state} chosen={chosen} />
      <Row
        label="Speech models"
        description={`They run on this device, offline: nothing you say leaves it. Downloaded from Hugging Face, every file checked against its pinned SHA-256. ${state.engine}.`}
      >
        {null}
      </Row>
      {state.models.map((m) => (
        <ModelRow key={m.id} model={m} state={state} />
      ))}
      <LanguageRow state={state} chosen={chosen} />
      <MicrophoneRow state={state} />
    </>
  );
}

function EngineRow({ state, chosen }: { state: DictationState; chosen: DictationModel | null }) {
  const pick = onDevicePick(state);
  const system = isTauri()
    ? hasWebSpeech()
      ? "The speech recognition built into this window."
      : "This window has none: the composers show no mic until you use a speech model."
    : hasWebSpeech()
      ? "This browser's speech recognition (Chrome and Edge send your voice to Google or Microsoft)."
      : "This browser has none: the composers show no mic until you use a speech model.";
  const description = chosen
    ? `${chosen.name}, on this device: works offline.`
    : pick
      ? `${system} Or a downloaded speech model, on this device.`
      : `${system} Download a speech model below to dictate on this device.`;
  return (
    <Row label="Speech recognition" description={description} wide>
      <SegmentedControl<"system" | "device">
        size="sm"
        aria-label="Speech recognition"
        value={chosen ? "device" : "system"}
        onValueChange={(v) => void change("dictation.select", v === "device" && pick ? { modelId: pick.id } : {}, "Couldn't change the speech recognition")}
        options={[
          { value: "system", label: "System" },
          { value: "device", label: "On this device", disabled: !pick },
        ]}
      />
    </Row>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${label}: ${value} of 5`}>
      <span className="text-2xs font-bold text-mute-2">{label}</span>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden className={cn("size-1.5 rounded-full", i <= value ? "bg-accent" : "bg-ink/15")} />
      ))}
    </span>
  );
}

function ModelRow({ model, state }: { model: DictationModel; state: DictationState }) {
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const inUse = state.selected === model.id;
  const pct = downloadPercent(model);
  const downloading = model.phase === "downloading";
  const resumable = model.phase === "available" && (model.downloaded ?? 0) > 0;

  const remove = async () => {
    const next = takeoverAfterRemoving(state, model.id);
    const after = inUse ? (next ? ` Dictation switches to ${next.name}.` : " The mic goes back to the system's speech recognition.") : "";
    const ok = await confirmAction({
      title: `Delete ${model.name}?`,
      body: `Its ${formatBytes(model.size)} leave this device; download it again to use it.${after}`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await run(() => change("dictation.remove", { modelId: model.id }, `Couldn't delete ${model.name}`));
  };

  let actions: ReactNode;
  if (downloading) {
    actions = (
      <Button size="sm" variant="ghost" icon={<X />} onClick={() => void run(() => change("dictation.cancelInstall", { modelId: model.id }, "Couldn't cancel the download"))}>
        Cancel
      </Button>
    );
  } else if (model.phase === "installed") {
    actions = (
      <>
        {!inUse && (
          <Button size="sm" loading={busy} onClick={() => void run(() => change("dictation.select", { modelId: model.id }, `Couldn't use ${model.name}`))}>
            Use
          </Button>
        )}
        <IconButton label={`Delete ${model.name}`} size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          <Trash2 />
        </IconButton>
      </>
    );
  } else {
    actions = (
      <Button
        size="sm"
        variant={model.recommended && !state.selected ? "primary" : "secondary"}
        icon={model.error ? <RefreshCw /> : <Download />}
        loading={busy}
        onClick={() => void run(() => change("dictation.install", { modelId: model.id }, `Couldn't download ${model.name}`))}
      >
        {model.error ? "Retry" : resumable ? "Resume" : "Download"}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 max-md:py-2.5" data-model={model.id}>
      <div className="min-w-0 flex-1 basis-80 max-md:basis-full">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-bold text-ink">{model.name}</span>
          {inUse && <Badge tone="done">In use</Badge>}
          {model.recommended && <Badge tone="accent">Recommended</Badge>}
          {isSlow(model) && <Badge className="bg-sun/16 text-sun-2">Slow for live dictation</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-mute">
          {formatBytes(model.size)} · {model.languages} · about {model.ramMb >= 1000 ? `${(model.ramMb / 1000).toFixed(1)} GB` : `${model.ramMb} MB`} of memory
        </p>
        <p className="mt-1 text-xs text-mute-2">
          {model.summary} {model.notes}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Meter label="Speed" value={model.speed} />
          <Meter label="Accuracy" value={model.accuracy} />
        </div>
        {(downloading || resumable) && pct !== null && (
          <span className="mt-2 flex items-center gap-2 text-2xs text-mute">
            <span role="progressbar" aria-label={`${model.name} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 flex-1 overflow-hidden rounded-full bg-tile-4">
              <span className={cn("block h-full rounded-full transition-[width] duration-300", downloading ? "bg-omp" : "bg-ink/30")} style={{ width: `${pct}%` }} />
            </span>
            <span className="shrink-0 tabular-nums">
              {formatBytes(model.downloaded ?? 0)} of {formatBytes(model.size)}
              {downloading ? ` · ${pct}%` : " · paused"}
            </span>
          </span>
        )}
        {model.error && !downloading && <p className="mt-1.5 text-xs font-semibold text-error">Download failed: {model.error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 max-md:w-full max-md:justify-end">{actions}</div>
    </div>
  );
}

function LanguageRow({ state, chosen }: { state: DictationState; chosen: DictationModel | null }) {
  const locale = typeof navigator === "undefined" ? "" : navigator.language;
  return (
    <Row label="Language" htmlFor="tf-dictation-language" description={languageNote(chosen, state, locale)} wide>
      <Select
        id="tf-dictation-language"
        className="w-56"
        value={state.language}
        onValueChange={(language) => void change("dictation.setLanguage", { language }, "Couldn't change the language")}
        options={languageOptions(state, chosen).map((l) => ({ value: l.code, label: l.name, ...(l.fits ? {} : { hint: `${chosen?.name ?? "This model"} doesn't know it` }) }))}
      />
    </Row>
  );
}

const DEFAULT_MIC = "__default";

/** The input to listen to: the devices this computer has now (listed when Settings opens), the system default first. */
function MicrophoneRow({ state }: { state: DictationState }) {
  const [mics, setMics] = useState<DictationMicrophone[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const list = async () => {
    setListing(true);
    try {
      const r = await core.app("dictation.microphones", {});
      setMics(r.microphones);
      setFailed(null);
    } catch (e) {
      setFailed(toApiError(e).message);
    } finally {
      setListing(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed once when the card opens; the button lists again.
  useEffect(() => {
    void list();
  }, []);
  const chosen = state.microphone;
  const systemDefault = mics?.find((m) => m.default);
  const options: SelectOption[] = [
    { value: DEFAULT_MIC, label: "System default", ...(systemDefault ? { hint: systemDefault.name } : {}) },
    ...(mics ?? []).map((m) => ({ value: m.id, label: m.name })),
  ];
  if (chosen && mics && !mics.some((m) => m.id === chosen.id)) options.push({ value: chosen.id, label: chosen.name, hint: "not connected: the default listens" });
  const description = failed
    ? `Couldn't list the microphones: ${failed}`
    : "Dictation and browser recordings listen to this one; one that isn't connected leaves it to the system default.";
  return (
    <Row label="Microphone" htmlFor="tf-dictation-mic" description={description} wide>
      <IconButton label="List the microphones again" size="sm" variant="ghost" disabled={listing} onClick={() => void list()}>
        <RefreshCw className={cn(listing && "animate-spin")} />
      </IconButton>
      <Select
        id="tf-dictation-mic"
        className="w-64"
        value={chosen?.id ?? DEFAULT_MIC}
        disabled={!mics}
        onValueChange={(v) => void change("dictation.setMicrophone", v === DEFAULT_MIC ? {} : { id: v }, "Couldn't change the microphone")}
        options={options}
      />
    </Row>
  );
}
