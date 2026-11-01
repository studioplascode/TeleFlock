/*
 * Input-method commits nothing announced. WebKitGTK (the Linux app) inserts text an input method
 * commits without a preedit (an IBus or Fcitx engine, such as a voice-input one, or an emoji the
 * input method spells for a synthetic keystroke) as `beforeinput`/`input` (insertFromComposition)
 * and `compositionend`, with no `compositionstart` before them. xterm.js counts from the start of
 * the composition it never saw: it sends the commit and then the stale contents of its textarea
 * again. The terminal takes such a commit itself (`TerminalPane`); compositions that start as
 * usual stay with xterm.
 */

/** A commit to send in xterm's place, and the textarea value from before it went in. */
export interface LoneCommit {
  text: string;
  before: string;
}

/** Follows the composition events of one terminal textarea. */
export class ImeCommits {
  private composing = false;
  private before: string | null = null;

  /** `compositionstart`: a composition xterm sees from its start. */
  start(): void {
    this.composing = true;
  }

  /** `beforeinput`: remembers the textarea value under a commit no composition announced. */
  beforeInput(inputType: string, value: string): void {
    if (!this.composing && inputType === "insertFromComposition") this.before = value;
  }

  /** `compositionend`: the commit to take from xterm, or null when xterm saw the composition start. */
  end(data: string): LoneCommit | null {
    const announced = this.composing;
    const before = this.before;
    this.composing = false;
    this.before = null;
    if (announced || before === null) return null;
    return { text: data, before };
  }
}
