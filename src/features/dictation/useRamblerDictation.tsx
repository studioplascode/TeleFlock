import { type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRambler, type Rambler, type RambleResult, type RambleState, prewarmRamble, suggestRamble, useCore, usePrefs } from "@/core";
import { type Dictation, useDictation } from "@/features/session/composer/useDictation";
import { joiner, replaceRange, type SetText, type TextField } from "./edit";
import { RamblerCard, RamblerResult } from "./RamblerCard";

export interface RamblerDictationOptions {
  /** The host whose model tidies the dictation: the composer's agent, Dispatch's target. Unset: any online host. */
  hostId?: string;
  /** Where the prompt goes, in a few words (repository, agent title): sent with every call so names are spelled right. */
  about?: string;
  /** The box's current text. */
  text: string;
  setText: SetText;
  field: RefObject<TextField | null>;
  /** Phone: the box is not focused for the fill (that would raise the keyboard), so it is a draft edit; Ctrl+Z then has nothing to undo, the strip's Undo does. */
  mobile: boolean;
  /** `sun`: the panel is drawn for the ask card's sunset background. */
  tone?: "sun";
}

export interface RamblerDictation {
  /** Use in place of `useDictation`: with Rambler on, `interim` stays empty (the card shows it) and nothing is written until the user stops. */
  dictation: Dictation;
  /** The Rambler card while dictating, the "Use raw transcript / Undo" strip after the fill, else null: render it above the box. */
  panel: ReactNode;
}

/** What the last fill put in the box, so the strip can swap it for the other version or take it out again. */
interface Fill {
  /** Where the filled text starts (after the joining space) and the space before it. */
  start: number;
  gap: number;
  /** The model's rewrite was used (not the raw fallback after a failure). */
  cleaned: boolean;
  /** In the box now, and the other version (`null`: none, they are the same or there is no rewrite). */
  shown: string;
  other: string | null;
  usingRaw: boolean;
  error: string | null;
  role: string;
}

const NONE: RambleState = { raw: "", clean: "", upToDate: true, thinking: false, error: null, ended: false };
const noSubscribe = () => () => {};

/** The first online host, for a composer without a host of its own. */
function useAnyOnlineHost(): string | undefined {
  return useCore((s) => s.profiles.find((p) => s.status[p.id]?.phase === "online")?.id);
}

/**
 * Dictation for a text box, with Rambler (Settings → Dictation) when it is on: the finished utterances go to a
 * `Rambler` session instead of the box, the card above shows the live rewrite, and when the user stops, the final
 * rewrite is filled in as one edit (Ctrl+Z undoes it) with "Use raw transcript" and Undo. Rambler off, or no host
 * to ask: the plain behaviour, each phrase appended as it is recognised.
 */
export function useRamblerDictation(o: RamblerDictationOptions): RamblerDictation {
  const enabled = usePrefs((s) => s.rambler);
  const role = usePrefs((s) => s.ramblerRole);
  const online = useAnyOnlineHost();
  const host = o.hostId ?? online;

  const [session, setSession] = useState<Rambler | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [fill, setFill] = useState<Fill | null>(null);
  /** The session `onFinal` / `onEnd` talk to (state would lag a render behind a tap). */
  const live = useRef<Rambler | null>(null);
  const ending = useRef<Rambler | null>(null);
  const latest = useRef(o);
  latest.current = o;

  const append = (phrase: string) => {
    if (phrase) latest.current.setText((t) => `${t}${joiner(t)}${phrase}`);
  };

  const apply = (res: RambleResult, usedRole: string) => {
    const { field, setText, mobile, text } = latest.current;
    if (!res.text) return;
    const before = text;
    const gap = joiner(before);
    replaceRange(field.current, setText, before.length, before.length, gap + res.text, !mobile);
    setFill({ start: before.length + gap.length, gap: gap.length, cleaned: res.cleaned, shown: res.text, other: res.cleaned && res.raw !== res.text ? res.raw : null, usingRaw: false, error: res.error, role: usedRole });
  };

  const end = () => {
    const s = live.current;
    if (!s || ending.current === s) return;
    ending.current = s;
    setFinishing(true);
    const usedRole = role;
    void s.finish().then((res) => {
      if (live.current !== s) return;
      live.current = null;
      ending.current = null;
      setSession(null);
      setFinishing(false);
      apply(res, usedRole);
    });
  };

  const dictation = useDictation(
    (phrase) => (live.current ? live.current.push(phrase) : append(phrase)),
    () => end(),
  );

  // The microphone could not start (permission, no engine): nothing will ever end this session.
  useEffect(() => {
    if (!dictation.error || dictation.listening || finishing || !live.current) return;
    live.current.cancel();
    live.current = null;
    setSession(null);
  }, [dictation.error, dictation.listening, finishing]);

  // Leaving the screen mid-dictation: what was said still lands in the draft.
  useEffect(() => () => end(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const state = useSyncExternalStore(session ? session.subscribe : noSubscribe, session ? session.state : () => NONE);

  const toggle = () => {
    if (finishing) return;
    if (!dictation.listening && enabled && host && dictation.supported) {
      const id = host;
      // The host starts omp now, while the person speaks: the first rewrite then finds it ready.
      prewarmRamble(id, { role });
      const next = createRambler({ rewrite: (input) => suggestRamble(id, input, { role }), ...(latest.current.about ? { about: latest.current.about } : {}) });
      live.current?.cancel();
      live.current = next;
      setSession(next);
      setFill(null);
    }
    dictation.toggle();
  };

  const shownFill = fill && o.text.slice(fill.start, fill.start + fill.shown.length) === fill.shown ? fill : null;

  const swap = () => {
    if (!shownFill?.other) return;
    const { field, setText, mobile } = latest.current;
    const next = shownFill.other;
    replaceRange(field.current, setText, shownFill.start, shownFill.start + shownFill.shown.length, next, !mobile);
    setFill({ ...shownFill, shown: next, other: shownFill.shown, usingRaw: !shownFill.usingRaw });
  };
  const undo = () => {
    if (!shownFill) return;
    const { field, setText, mobile } = latest.current;
    replaceRange(field.current, setText, shownFill.start - shownFill.gap, shownFill.start + shownFill.shown.length, "", !mobile);
    setFill(null);
  };

  const panel: ReactNode =
    session && (dictation.listening || finishing) ? (
      <RamblerCard state={state} interim={dictation.interim} listening={dictation.listening} finishing={finishing} role={role} mobile={o.mobile} tone={o.tone} />
    ) : shownFill ? (
      <RamblerResult
        cleaned={shownFill.cleaned}
        usingRaw={shownFill.usingRaw}
        canSwap={shownFill.other !== null}
        error={shownFill.error}
        role={shownFill.role}
        onSwap={swap}
        onUndo={undo}
        onDismiss={() => setFill(null)}
        mobile={o.mobile}
        tone={o.tone}
      />
    ) : null;

  return { dictation: { ...dictation, toggle, interim: session ? "" : dictation.interim }, panel };
}
