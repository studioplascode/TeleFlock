/**
 * Expressions the panel evaluates in a tab (`Runtime.evaluate`, without `Runtime.enable`). Each
 * starts with a `/*tf:<name>*\/` marker, which is how the demo's fake browser recognizes them.
 * They run in the panel's isolated world when one exists (`Page.createIsolatedWorld`), so a page's
 * own globals and monkey patches neither see nor change them.
 */

/** The page's icon address: the last `<link rel=icon>` (any size), else `/favicon.ico`. */
export const FAVICON_SCRIPT = `/*tf:favicon*/(() => {
  const links = [...document.querySelectorAll('link[rel~="icon" i], link[rel="shortcut icon" i]')];
  const href = links.length ? links[links.length - 1].href : "";
  if (href) return href;
  return /^https?:$/.test(location.protocol) ? new URL("/favicon.ico", location.href).href : "";
})()`;

/** The selected text: inside the focused text field, else the document's selection (Copy, Cut). */
export const SELECTION_SCRIPT = `/*tf:selection*/(() => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number") {
    if (a.type === "password") return "";
    return a.value.slice(a.selectionStart, a.selectionEnd ?? a.selectionStart);
  }
  const s = getSelection();
  return s ? String(s) : "";
})()`;

/** The CSS cursor at a viewport point (`auto` resolves to `text` over editable text, else `default`). */
export function cursorScript(x: number, y: number): string {
  return `/*tf:cursor*/((x, y) => {
  let e = document.elementFromPoint(x, y);
  while (e && e.shadowRoot) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  if (!e) return "default";
  const c = getComputedStyle(e).cursor;
  if (c && c !== "auto") return c;
  const editable = e.isContentEditable || e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(e.type));
  return editable ? "text" : "default";
})(${Math.round(x)}, ${Math.round(y)})`;
}

/**
 * What the element scripts share. `isFrame`, `frameDoc` (a frame element's document when this
 * world may read it: same origin; else null), `contentAt` (where a frame's content starts in its
 * parent's viewport), `topRect` (an element's rectangle in the tab's viewport, CSS px, cut to the
 * frames it is inside) and `known`: the elements looked up on this page, by ref (`ElementInfo.ref`;
 * the prefix is new with every page, so a ref never names an element of another page), each with
 * its root (document or shadow root) and selector there to find it again when the page replaced it.
 */
const SHARED = `
  const isFrame = (n) => /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(n.tagName);
  const frameDoc = (f) => { try { return f.tagName === "EMBED" ? null : f.contentDocument || null; } catch { return null; } };
  const contentAt = (f) => {
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    return { x: r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0) };
  };
  const topRect = (el) => {
    const r = el.getBoundingClientRect();
    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (let win = el.ownerDocument.defaultView; win && win.frameElement; win = win.frameElement.ownerDocument.defaultView) {
      x1 = Math.max(x1, 0); y1 = Math.max(y1, 0); x2 = Math.min(x2, win.innerWidth); y2 = Math.min(y2, win.innerHeight);
      const o = contentAt(win.frameElement);
      x1 += o.x; x2 += o.x; y1 += o.y; y2 += o.y;
    }
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  };
  const known = window.__tfElements || (window.__tfElements = { prefix: Math.random().toString(36).slice(2, 8), next: 0, ids: new WeakMap(), byRef: new Map() });`;

/**
 * What the element at a viewport point (or, without a point, the focused element) is, for the
 * recording log: tag, id, name, role, type, a short label, link, a CSS selector, whether it holds
 * secrets, its rectangle in the tab's viewport (where the screencast shows it) with the page's
 * scroll offset then, and a ref to measure it again (`measureScript`). It is found through open
 * shadow roots and same-origin frames (the selector names each host on the way: `#pay >>> #card`);
 * a frame it can't look into (another origin's: card and 3-D Secure forms) is the element,
 * sensitive as a whole.
 */
export function elementScript(point?: { x: number; y: number }): string {
  const at = point ? `${Math.round(point.x)}, ${Math.round(point.y)}` : "null, null";
  return `/*tf:element*/((x, y) => {${SHARED}
  const text = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const selector = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + esc(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const hosts = [];
  let e = x == null ? document.activeElement : document.elementFromPoint(x, y);
  let px = x, py = y, opaque = false;
  for (let depth = 0; e && depth < 32; depth++) {
    const shadow = e.shadowRoot;
    const inner = shadow && (x == null ? shadow.activeElement : shadow.elementFromPoint(px, py));
    if (inner && inner !== e) { hosts.push(selector(e)); e = inner; continue; }
    if (!isFrame(e)) break;
    const doc = frameDoc(e);
    if (!doc) { opaque = true; break; }
    let next;
    if (x == null) next = doc.activeElement;
    else { const o = contentAt(e); px -= o.x; py -= o.y; next = doc.elementFromPoint(px, py); }
    if (!next || next === doc.body || next === doc.documentElement) break;
    hosts.push(selector(e));
    e = next;
  }
  if (!e || e === document.body || e === document.documentElement) return null;
  const pick = opaque ? e : e.closest("a,button,input,textarea,select,label,[role],[contenteditable=true]") || e;
  const ac = (pick.getAttribute("autocomplete") || "").toLowerCase();
  const type = (pick.getAttribute("type") || "").toLowerCase();
  const sensitive = opaque || type === "password" || /^cc-|one-time-code|current-password|new-password/.test(ac);
  const named = pick.getAttribute("aria-label") || (pick.labels && pick.labels[0] && pick.labels[0].innerText) || pick.getAttribute("placeholder") || pick.getAttribute("alt") || pick.getAttribute("title");
  const label = text(named || (pick.tagName === "INPUT" ? "" : pick.innerText));
  const own = selector(pick);
  let ref = known.ids.get(pick);
  if (!ref) {
    ref = known.prefix + "-" + ++known.next;
    known.ids.set(pick, ref);
    known.byRef.set(ref, { el: new WeakRef(pick), root: new WeakRef(pick.getRootNode()), selector: own });
    if (known.byRef.size > 500) known.byRef.delete(known.byRef.keys().next().value);
  }
  return {
    tag: pick.tagName.toLowerCase(),
    id: pick.id || undefined,
    name: pick.getAttribute("name") || undefined,
    role: pick.getAttribute("role") || undefined,
    type: type || undefined,
    label: label || undefined,
    textLabel: (!named && !!label) || undefined,
    href: pick.href ? String(pick.href) : undefined,
    autocomplete: ac || undefined,
    selector: hosts.concat(own).join(" >>> "),
    sensitive,
    rect: topRect(pick),
    scroll: { x: scrollX, y: scrollY },
    ref,
  };
})(${at})`;
}

/**
 * Where the elements of earlier lookups (`ElementInfo.ref`) are now, as `elementScript` measures
 * them, with the page's scroll offset: null for one that is gone (its page too). An element the
 * page replaced is found again by its selector in the same document or shadow root.
 */
export function measureScript(refs: readonly string[]): string {
  return `/*tf:measure*/((refs) => {${SHARED}
  const rects = refs.map((ref) => {
    const it = known.byRef.get(ref);
    if (!it) return null;
    let el = it.el.deref();
    if (!el || !el.isConnected) {
      const root = it.root.deref();
      const live = root && (root.nodeType === 9 ? !!root.defaultView : root.host.isConnected);
      el = live ? root.querySelector(it.selector) : null;
      if (!el) return null;
      it.el = new WeakRef(el);
      known.ids.set(el, ref);
    }
    return topRect(el);
  });
  return { scroll: { x: scrollX, y: scrollY }, rects };
})(${JSON.stringify(refs)})`;
}

/** The name of the script an expression runs (`favicon`, `selection`, `cursor`, `element`, `measure`), if it is one of these. */
export function scriptName(expression: string): string | undefined {
  return /^\/\*tf:([a-z]+)\*\//.exec(expression)?.[1];
}
