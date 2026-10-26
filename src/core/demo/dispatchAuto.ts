/*
 * Demo support for Dispatch 0.5: both demo hosts form one host group (so `?demo` shows Auto
 * spreading tasks over forge and studio-pc), and a first prompt may carry images.
 */

/** The demo hosts' group (Dispatch → "Auto · Demo flock"). */
export const DEMO_GROUP = "Demo flock";

/**
 * The text a demo agent's first turn starts with: the prompt, else a note for an image-only
 * prompt (the demo model "reads" the screenshot), else nothing.
 */
export function demoFirstPrompt(spec: Record<string, unknown>): string | undefined {
  const text = typeof spec.prompt === "string" ? spec.prompt.trim() : "";
  const images = Array.isArray(spec.images) ? spec.images.length : 0;
  if (text) return images ? `${text}\n\n[${images === 1 ? "1 image" : `${images} images`} attached]` : text;
  return images ? `Look at the attached ${images === 1 ? "screenshot" : `${images} screenshots`} and fix what they show` : undefined;
}
