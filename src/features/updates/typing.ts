let typedAt: number | undefined;
let installed = false;

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t.isContentEditable;
}

/**
 * Remembers when the user last pressed a key in a text field (the composer, the terminal's hidden
 * textarea, any input), so overlays that interrupt can wait until they stop. Idempotent.
 */
export function startTypingTracker(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (isTextTarget(e.target)) typedAt = Date.now();
    },
    { capture: true, passive: true },
  );
}

/** When a key was last pressed in a text field, if ever. */
export function lastTypedAt(): number | undefined {
  return typedAt;
}
