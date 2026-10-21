/**
 * Shared-element morphs between screens (board card → session header). Mark the matching parts on
 * both screens:
 *
 *   <div data-morph="surface" data-morph-key={agentKey}>   // card / header container
 *     <span data-morph="glyph" data-morph-key={agentKey}>  // avatar
 *     <span data-morph="name" data-morph-key={agentKey}>   // agent name
 *
 * then navigate through `morphTo(agentKey, () => navigate(...))`. The source parts are lifted
 * into a fixed ghost layer, the route changes immediately (nothing blocks or freezes), and once
 * the next screen mounts its tagged parts the ghosts fly onto them and hand over. Compositor-only
 * except the surface box, which is a single childless element. No-op under reduced motion.
 */

export const MORPH_PARTS = ["surface", "glyph", "name"] as const;
export type MorphPart = (typeof MORPH_PARTS)[number];

/** How long the ghosts wait (lifted) for a code-split screen to mount its tagged parts. */
const TARGET_WAIT_MS = 1200;
const FLIGHT_MS = 520;
const FLIGHT_EASE = "cubic-bezier(0.22, 1.12, 0.36, 1)";

function tagged(key: string): Map<MorphPart, HTMLElement> {
  const out = new Map<MorphPart, HTMLElement>();
  for (const el of document.querySelectorAll<HTMLElement>(`[data-morph-key="${CSS.escape(key)}"]`)) {
    const part = el.dataset.morph as MorphPart | undefined;
    if (!part || out.has(part) || !MORPH_PARTS.includes(part) || el.dataset.morphGone !== undefined) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    out.set(part, el);
  }
  return out;
}

function place(el: HTMLElement, r: DOMRect): void {
  Object.assign(el.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0" });
}

/** A visual copy of one part: the surface is an empty painted box, glyph/name keep their content. */
function ghost(part: MorphPart, el: HTMLElement): HTMLElement {
  const cs = getComputedStyle(el);
  const g = part === "surface" ? document.createElement("div") : (el.cloneNode(true) as HTMLElement);
  for (const n of [g, ...g.querySelectorAll<HTMLElement>("[data-morph]")]) {
    delete n.dataset.morph;
    delete n.dataset.morphKey;
  }
  // Status colours come from an ancestor's data-status; carry it over.
  const status = el.closest<HTMLElement>("[data-status]")?.dataset.status;
  if (status) g.dataset.status = status;
  if (part === "surface") {
    Object.assign(g.style, { background: cs.background, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border });
  } else {
    Object.assign(g.style, { font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color, whiteSpace: "nowrap", transformOrigin: "0 0" });
  }
  place(g, el.getBoundingClientRect());
  return g;
}

/** Run `update` (a route change) as a shared-element morph of everything tagged with `key`. */
export function morphTo(key: string, update: () => void): void {
  const reduced = document.documentElement.dataset.motion === "reduced" || typeof Element.prototype.animate !== "function";
  const sources = reduced ? new Map<MorphPart, HTMLElement>() : tagged(key);
  if (sources.size === 0) {
    update();
    return;
  }

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "var(--z-drag)", pointerEvents: "none" });
  const ghosts = new Map<MorphPart, HTMLElement>();
  for (const part of MORPH_PARTS) {
    const el = sources.get(part);
    if (!el) continue;
    const g = ghost(part, el);
    ghosts.set(part, g);
    layer.append(g);
  }
  document.body.append(layer);
  for (const el of sources.values()) {
    el.dataset.morphGone = "";
    el.style.visibility = "hidden";
  }
  // Lift while the next screen loads.
  ghosts.get("surface")?.animate([{ transform: "none" }, { transform: "translateY(-4px) scale(1.015)" }], { duration: 260, easing: FLIGHT_EASE, fill: "forwards" });

  update();

  const until = performance.now() + TARGET_WAIT_MS;
  const land = () => {
    const targets = tagged(key);
    if (targets.size === 0 && performance.now() < until) {
      requestAnimationFrame(land);
      return;
    }
    const flights: Animation[] = [];
    for (const [part, g] of ghosts) {
      const target = targets.get(part);
      if (!target) {
        flights.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" }));
        continue;
      }
      const from = g.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      target.style.opacity = "0";
      const opts: KeyframeAnimationOptions = { duration: FLIGHT_MS, easing: FLIGHT_EASE, fill: "forwards" };
      if (part === "surface") {
        const radius = getComputedStyle(target).borderRadius;
        flights.push(
          g.animate(
            [
              { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, transform: "none" },
              { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: radius, transform: "none", opacity: 0.6 },
            ],
            opts,
          ),
        );
      } else {
        const sx = to.width / Math.max(1, from.width);
        const sy = to.height / Math.max(1, from.height);
        const s = part === "name" ? sy : Math.min(sx, sy);
        flights.push(g.animate([{ transform: "none" }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${s})` }], opts));
      }
      target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: FLIGHT_MS, easing: "ease-out" }).finished.then(
        () => target.style.removeProperty("opacity"),
        () => target.style.removeProperty("opacity"),
      );
    }
    const done = () => {
      for (const [, g] of ghosts) g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
      // Sources usually unmount with the old screen; if they survive (same-route open), show them again.
      for (const el of sources.values()) {
        delete el.dataset.morphGone;
        el.style.removeProperty("visibility");
      }
      setTimeout(() => layer.remove(), 130);
    };
    Promise.all(flights.map((f) => f.finished)).then(done, done);
  };
  requestAnimationFrame(land);
}
