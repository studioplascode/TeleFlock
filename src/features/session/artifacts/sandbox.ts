/**
 * HTML artifacts in a sandbox (architecture "Presented artifacts"). A page the agent presented is
 * shown in two nested frames, both `sandbox="allow-scripts"` (scripts run, in an opaque origin: no
 * cookies, storage or DOM of the app, no popups, forms, downloads, modals or top navigation):
 *
 * - the wrapper, whose Content-Security-Policy ({@link ARTIFACT_CSP}) allows no network loads and
 *   no frame navigation (`frame-src 'none'` also stops the page from navigating its own frame away);
 *   in a browser an `srcdoc` iframe, in the desktop app a document served from the `tfdoc:` scheme
 *   (src-tauri `docs.rs`), so it does not inherit the app's own CSP;
 * - the artifact, an `srcdoc` iframe in the wrapper: it inherits the wrapper's policy and carries
 *   it once more ahead of all of its own markup, with a prelude that runs before any of its
 *   scripts: it removes WebRTC and keeps the page's scripts from adding resource hints through the
 *   DOM (CSP covers neither), and turns link clicks into a message to the app, which opens http(s)
 *   links in the system browser only after the user confirms.
 *
 * Resource hints in the page's own markup (`<link rel>` preconnect, dns-prefetch, prefetch,
 * prerender, modulepreload) are dropped before it is shown or saved. What the page can still reach
 * is listed in architecture §3.32.
 *
 * The Android app shows pages without scripts ({@link STATIC_SANDBOX}, both frames `srcdoc`).
 *
 * Files the page references by relative path (the bridge copied them into
 * `presented/<slug>-v<n>.files/`) are inlined as `data:` URLs within {@link ASSET_LIMITS}; anything
 * else it references stays as written and does not load.
 *
 * The markup is the agent's, so every scan here is linear in its length: nothing is matched again
 * from each later position, and a tag or comment the markup never ends ends the scan.
 */

/** What an artifact page may load: inline and `data:`/`blob:` content only, nothing over the network. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "worker-src data: blob:",
  "frame-src 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "manifest-src 'none'",
].join("; ");

/** Both frames: scripts, nothing else (never `allow-same-origin`). */
export const FRAME_SANDBOX = "allow-scripts";
/**
 * The Android app shows pages without scripts: its WebView injects Tauri's IPC scripts into every
 * frame (wry adds them for all frames on Android), so a page whose scripts run could reach the app's
 * commands there. Without `allow-scripts` nothing in the page runs, injected scripts included.
 */
export const STATIC_SANDBOX = "";

/** Files inlined into one document: how many, each, together (the bridge copies as many), and how deep stylesheets import. */
export const ASSET_LIMITS = { count: 64, each: 4 << 20, total: 16 << 20, cssDepth: 2 } as const;

/** The marker of the messages the artifact's prelude posts to the app. */
export const LINK_MESSAGE = "tfArtifact";

/**
 * Runs first in an artifact page (and in its saved copy): removes WebRTC, and drops the resource
 * hints (`rel` preconnect, dns-prefetch, prefetch, prerender, modulepreload) the page's scripts set
 * on a `<link>` through the DOM (`rel`, `relList`, `setAttribute(NS)`, attribute nodes). Browsers
 * apply CSP to neither: a peer connection's STUN/TURN traffic and a preconnect's DNS lookup and TCP
 * handshake (a prerender's whole request in Chromium) reach the network. Best effort: markup the
 * page parses from strings (`innerHTML`, `document.write`, frames it creates) is not covered.
 * Uses `window` only, so a test can run it on a stand-in.
 */
export const PAGE_GUARD = `(() => {
  const w = window;
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
    try { Object.defineProperty(w, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  const { HTMLLinkElement: L, Element: E, Attr: A, Node: N, NamedNodeMap: M, DOMTokenList: T } = w;
  if (!L || !E) return;
  const hint = (t) => /^(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)$/i.test(String(t));
  const clean = (v) => String(v).split(/[\\t\\n\\f\\r ]+/).filter((t) => t && !hint(t)).join(" ");
  const isRel = (el, ns, name) => el instanceof L && (ns === null || ns === undefined || ns === "") && String(name).toLowerCase() === "rel";
  const owned = (a) => !!a && !!a.ownerElement && isRel(a.ownerElement, a.namespaceURI, a.name);
  const patch = (proto, name, make) => {
    try {
      const d = proto && Object.getOwnPropertyDescriptor(proto, name);
      if (d) Object.defineProperty(proto, name, Object.assign({}, d, make(d)));
    } catch (e) {}
  };
  patch(L.prototype, "rel", (d) => ({ set(v) { d.set.call(this, clean(v)); } }));
  patch(E.prototype, "setAttribute", (d) => ({ value(...a) { if (a.length > 1 && isRel(this, null, a[0])) a[1] = clean(a[1]); return d.value.apply(this, a); } }));
  patch(E.prototype, "setAttributeNS", (d) => ({ value(...a) { if (a.length > 2 && isRel(this, a[0], a[1])) a[2] = clean(a[2]); return d.value.apply(this, a); } }));
  const adopt = (el, a) => { if (A && a instanceof A && isRel(el, a.namespaceURI, a.name)) a.value = clean(a.value); };
  for (const k of ["setAttributeNode", "setAttributeNodeNS"]) patch(E.prototype, k, (d) => ({ value(...a) { adopt(this, a[0]); return d.value.apply(this, a); } }));
  const maps = new WeakMap();
  patch(E.prototype, "attributes", (d) => ({ get() { const m = d.get.call(this); if (m) maps.set(m, this); return m; } }));
  if (M) for (const k of ["setNamedItem", "setNamedItemNS"]) patch(M.prototype, k, (d) => ({ value(...a) { const el = maps.get(this); if (el) adopt(el, a[0]); return d.value.apply(this, a); } }));
  if (A) patch(A.prototype, "value", (d) => ({ set(v) { d.set.call(this, owned(this) ? clean(v) : v); } }));
  if (N) for (const k of ["nodeValue", "textContent"]) patch(N.prototype, k, (d) => ({ set(v) { d.set.call(this, A && this instanceof A && owned(this) ? clean(v) : v); } }));
  const lists = new WeakSet();
  patch(L.prototype, "relList", (d) => ({ get() { const l = d.get.call(this); if (l) lists.add(l); return l; } }));
  if (T) {
    patch(T.prototype, "add", (d) => ({ value(...t) { return d.value.apply(this, lists.has(this) ? t.filter((x) => !hint(x)) : t); } }));
    patch(T.prototype, "toggle", (d) => ({ value(...t) { return lists.has(this) && hint(t[0]) ? false : d.value.apply(this, t); } }));
    patch(T.prototype, "replace", (d) => ({ value(...t) { return lists.has(this) && hint(t[1]) ? false : d.value.apply(this, t); } }));
    patch(T.prototype, "value", (d) => ({ set(v) { d.set.call(this, lists.has(this) ? clean(v) : v); } }));
  }
})();`;

/** Runs in the app's copy only: a click on a link (other than to an anchor in the page) becomes a message to the app instead of a navigation. */
const LINK_CLICKS = `(() => {
  const send = (m) => { try { top.postMessage(Object.assign({ ${LINK_MESSAGE}: 1 }, m), "*"); } catch (e) {} };
  addEventListener("click", (e) => {
    const t = e.target;
    const a = t && t.closest ? t.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    send({ open: href });
  }, true);
})();`;

/** One referenced file, ready to inline. */
export interface InlineAsset {
  mime: string;
  base64: string;
  /** Stylesheets: the decoded text (their own references are inlined too). */
  text?: string;
}

/** Escapes text for a double-quoted attribute value. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A reference relative to a document (`img/chart.png?v=2`, `../x.css`) as a `/`-separated path
 * inside the document's folder (`base`: the folder of the stylesheet it came from), or undefined:
 * other schemes, absolute paths, fragments, and paths that leave the folder. The bridge copies files
 * by the same rule (`normalizeAssetRef` in host/teleflock-bridge).
 */
export function assetKey(ref: string, base = ""): string | undefined {
  let r = ref.trim();
  if (!r || r.startsWith("#") || r.startsWith("/") || r.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return undefined;
  r = r.replace(/[?#][\s\S]*$/, "");
  try {
    r = decodeURIComponent(r);
  } catch {
    /* kept as written */
  }
  if (!r || r.includes("\\") || r.includes("\0")) return undefined;
  const out = base ? base.split("/") : [];
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join("/") : undefined;
}

/** The folder of a key (`css/site.css` → `css`, `a.css` → ``). */
export const keyDir = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf("/")));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", tab: "\t", newline: "\n" };

/** Character references in an attribute value; numeric ones also without their `;`, as browsers read them. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+;?|#\d+;?|[a-z]+;)/gi, (whole, ref: string) => {
    const e = ref.endsWith(";") ? ref.slice(0, -1) : ref;
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

// ── linear scanning ──

/** ASCII whitespace as the HTML tokenizer knows it: tab, LF, FF, CR, space. */
const htmlSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
/** What `\s` matches in a regular expression. */
const jsSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || (c > 127 && /\s/.test(String.fromCharCode(c)));
const isLetter = (c: number): boolean => (c | 32) >= 97 && (c | 32) <= 122;

/**
 * The first index at or after `from` where `test` holds in `text`, or -1. It keeps its last answer
 * (nothing matches from that query up to it), so queries that mostly move forward look at each
 * character about once; any order answers correctly.
 */
function seeker(text: string, test: (code: number) => boolean): (from: number) => number {
  let asked = Number.POSITIVE_INFINITY;
  let found = -1;
  const scan = (from: number, until: number): number => {
    for (let i = from; i < until; i++) if (test(text.charCodeAt(i))) return i;
    return -1;
  };
  return (from) => {
    let at: number;
    if (from >= asked) {
      if (found === -1 || from <= found) return found;
      at = scan(from, text.length);
    } else {
      at = scan(from, Math.min(asked, text.length));
      if (at === -1) at = found;
    }
    asked = from;
    found = at;
    return at;
  };
}

/**
 * The end (index after it) of the comment starting at `lt` (`<!--`), where the HTML tokenizer ends
 * it: `<!-->` and `<!--->` at once, else at the first `--` (more dashes allowed) followed by `>` or
 * `!>`; at the end of the markup when nothing ends it.
 */
function commentEnd(s: string, lt: number): number {
  const i = lt + 4;
  if (s.charCodeAt(i) === 62) return i + 1;
  if (s.charCodeAt(i) === 45 && s.charCodeAt(i + 1) === 62) return i + 2;
  for (let from = i; ; ) {
    const dash = s.indexOf("--", from);
    if (dash < 0) return s.length;
    let j = dash + 2;
    while (s.charCodeAt(j) === 45) j++;
    if (s.charCodeAt(j) === 62) return j + 1;
    if (s.charCodeAt(j) === 33 && s.charCodeAt(j + 1) === 62) return j + 2;
    from = j;
  }
}

/**
 * The tag whose name starts at `from` (just after `<` or `</`): where its name ends and the index
 * after its `>`, or -1 when the markup ends inside it (a browser drops such a tag and everything
 * after it). As the HTML tokenizer reads it: quotes count only around attribute values.
 */
function scanTag(s: string, from: number): { nameEnd: number; end: number } {
  const n = s.length;
  let i = from;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (htmlSpace(c) || c === 47 || c === 62) break;
    i++;
  }
  const nameEnd = i;
  for (;;) {
    while (i < n && (htmlSpace(s.charCodeAt(i)) || s.charCodeAt(i) === 47)) i++;
    if (i >= n) return { nameEnd, end: -1 };
    if (s.charCodeAt(i) === 62) return { nameEnd, end: i + 1 };
    // An attribute's name (its first character may be `=`), then maybe `=` and its value.
    i++;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (htmlSpace(c) || c === 47 || c === 62 || c === 61) break;
      i++;
    }
    while (i < n && htmlSpace(s.charCodeAt(i))) i++;
    if (i >= n) return { nameEnd, end: -1 };
    if (s.charCodeAt(i) !== 61) continue;
    i++;
    while (i < n && htmlSpace(s.charCodeAt(i))) i++;
    if (i >= n) return { nameEnd, end: -1 };
    const q = s.charCodeAt(i);
    if (q === 34 || q === 39) {
      const close = s.indexOf(q === 34 ? '"' : "'", i + 1);
      if (close < 0) return { nameEnd, end: -1 };
      i = close + 1;
    } else if (q === 62) {
      return { nameEnd, end: i + 1 };
    } else {
      while (i < n) {
        const c = s.charCodeAt(i);
        if (htmlSpace(c) || c === 62) break;
        i++;
      }
    }
  }
}

const ATTR_RE = /([^\s=/>"']+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
/** Elements whose `src` loads a file (frames, objects and embeds never load in the viewer). */
const SRC_TAGS: Record<string, true> = { img: true, script: true, source: true, video: true, audio: true, track: true, input: true };
const SVG_REF_TAGS: Record<string, true> = { image: true, use: true, feimage: true };
/** Elements whose content is text up to their end tag, whatever it looks like (`noscript` is not: a page without scripts parses it). */
const RAW_TEXT: Record<string, true> = { script: true, style: true, textarea: true, title: true, xmp: true, iframe: true, noembed: true, noframes: true };

/** `rel` tokens of a `<link>` that make a browser connect, prefetch or prerender, which CSP doesn't stop. */
const HINT_REL = /^(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)$/i;

/** A link's `rel` without resource-hint tokens (and without tokens a reference this decoder doesn't
 *  know left undecoded), or undefined when it has none to drop. */
export function withoutHints(rel: string): string | undefined {
  const tokens = rel.split(/[\t\n\f\r ]+/).filter(Boolean);
  const kept = tokens.filter((t) => !HINT_REL.test(t) && !t.includes("&"));
  return kept.length === tokens.length ? undefined : kept.join(" ");
}

/** Which attribute of a start tag loads a file (and how its value lists references), or is a `<link>`'s `rel`. */
function refAttr(tag: string, attr: string, attrs: ReadonlyMap<string, string>): "url" | "srcset" | "css" | "rel" | undefined {
  if (attr === "style") return "css";
  if (attr === "src") return SRC_TAGS[tag] ? "url" : undefined;
  if (attr === "srcset") return tag === "img" || tag === "source" ? "srcset" : undefined;
  if (attr === "poster") return tag === "video" ? "url" : undefined;
  if (attr === "rel") return tag === "link" ? "rel" : undefined;
  if (attr === "href" || attr === "xlink:href") {
    if (SVG_REF_TAGS[tag]) return "url";
    if (tag === "link" && attr === "href" && /(?:^|\s)(?:stylesheet|icon)(?:\s|$)/i.test(attrs.get("rel") ?? "")) return "url";
  }
  return undefined;
}

interface Attr {
  name: string;
  value: string;
  /** Offsets of the whole attribute in the tag's attribute text. */
  start: number;
  end: number;
}

function parseAttrs(text: string): Attr[] {
  const out: Attr[] = [];
  for (const m of text.matchAll(ATTR_RE)) {
    out.push({ name: m[1]!.toLowerCase(), value: decodeEntities(m[3] ?? m[4] ?? m[5] ?? ""), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** A stylesheet without its comments (one that never ends runs to the end). */
function stripCssComments(css: string): string {
  let out = "";
  for (let from = 0; ; ) {
    const open = css.indexOf("/*", from);
    if (open < 0) return out + css.slice(from);
    out += css.slice(from, open);
    const close = css.indexOf("*/", open + 2);
    if (close < 0) return out;
    from = close + 2;
  }
}

/** The `url(…)` references of a stylesheet (quoted, or a bare run up to `)` or a space), with their spans. */
function cssUrls(css: string): Array<{ start: number; end: number; ref: string }> {
  const out: Array<{ start: number; end: number; ref: string }> = [];
  const nonSpace = seeker(css, (c) => !jsSpace(c));
  const quote = { 34: seeker(css, (c) => c === 34), 39: seeker(css, (c) => c === 39) };
  const bareEnd = seeker(css, (c) => c === 41 || c === 34 || c === 39 || jsSpace(c));
  const re = /url\(/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const j = nonSpace(m.index + 4);
    if (j < 0) break;
    const q = css.charCodeAt(j);
    let ref: string;
    let k: number;
    if (q === 34 || q === 39) {
      const close = quote[q](j + 1);
      if (close < 0) continue;
      ref = css.slice(j + 1, close);
      k = close + 1;
    } else {
      const stop = bareEnd(j);
      if (stop < 0 || stop === j) continue;
      ref = css.slice(j, stop);
      k = stop;
    }
    const e = nonSpace(k);
    if (e < 0 || css.charCodeAt(e) !== 41) continue;
    out.push({ start: m.index, end: e + 1, ref });
    re.lastIndex = e + 1;
  }
  return out;
}

/** `url()` and `@import` references of a stylesheet (comments skipped). */
export function cssRefs(css: string): string[] {
  const text = stripCssComments(css);
  const refs = cssUrls(text).map((u) => u.ref);
  for (const m of text.matchAll(CSS_IMPORT_RE)) refs.push(m[1] ?? m[2] ?? "");
  return refs.filter(Boolean);
}

/** `url(…)` / `@import "…"` references in `css` replaced by what `resolve` answers (kept when undefined). */
export function rewriteCss(css: string, resolve: (ref: string) => string | undefined): string {
  let out = "";
  let from = 0;
  for (const u of cssUrls(css)) {
    const url = resolve(u.ref);
    if (!url) continue;
    out += `${css.slice(from, u.start)}url("${url}")`;
    from = u.end;
  }
  return (out + css.slice(from)).replace(CSS_IMPORT_RE, (whole, a?: string, b?: string) => {
    const url = resolve(a ?? b ?? "");
    return url ? `@import url("${url}")` : whole;
  });
}

type Visit = (kind: "url" | "srcset" | "css" | "rel", value: string) => string | undefined;

/**
 * Walks the start tags of `markup` (HTML or SVG) as a browser's tokenizer finds them (comments,
 * end tags, doctypes and the text of script, style, title, textarea and the like skipped) and calls
 * `visit` for each attribute that loads a file, each `<link>`'s `rel` and each `<style>` block's
 * text. `visit` answers the replacement value (or undefined to keep it); the rewritten markup is
 * returned. One pass; a tag the markup never closes ends it.
 */
function walkMarkup(markup: string, visit: Visit): string {
  const n = markup.length;
  let out = "";
  let copied = 0;
  for (let i = 0; i < n; ) {
    const lt = markup.indexOf("<", i);
    if (lt < 0) break;
    const c = markup.charCodeAt(lt + 1);
    if (c === 33 || c === 63) {
      // A comment; a doctype, CDATA or `<?…>`: up to the first `>`.
      if (markup.startsWith("<!--", lt)) {
        i = commentEnd(markup, lt);
        continue;
      }
      const gt = markup.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (c === 47) {
      const d = markup.charCodeAt(lt + 2);
      if (isLetter(d)) {
        const end = scanTag(markup, lt + 2).end;
        if (end < 0) break;
        i = end;
      } else if (d === 62) i = lt + 3;
      else {
        const gt = markup.indexOf(">", lt + 2);
        if (gt < 0) break;
        i = gt + 1;
      }
      continue;
    }
    if (!isLetter(c)) {
      i = lt + 1;
      continue;
    }
    const scanned = scanTag(markup, lt + 1);
    if (scanned.end < 0) break;
    const name = markup.slice(lt + 1, scanned.nameEnd);
    const tag = name.toLowerCase();
    const attrText = markup.slice(scanned.nameEnd, scanned.end - 1);
    const attrs = parseAttrs(attrText);
    const byName = new Map(attrs.map((a) => [a.name, a.value] as const));
    let rebuilt = "";
    let from = 0;
    for (const a of attrs) {
      const kind = refAttr(tag, a.name, byName);
      if (!kind) continue;
      const next = visit(kind, a.value);
      if (next === undefined || next === a.value) continue;
      rebuilt += `${attrText.slice(from, a.start)}${a.name}="${escapeAttr(next)}"`;
      from = a.end;
    }
    if (rebuilt) {
      out += markup.slice(copied, lt) + `<${name}${rebuilt}${attrText.slice(from)}>`;
      copied = scanned.end;
    }
    i = scanned.end;
    if (tag === "plaintext") break;
    if (RAW_TEXT[tag] && !attrText.trimEnd().endsWith("/")) {
      // Searched in `markup` itself: a lowercased copy can be longer (`İ` becomes two units).
      const endTag = new RegExp(`</${tag}`, "gi");
      endTag.lastIndex = scanned.end;
      const end = endTag.exec(markup)?.index ?? n;
      if (tag === "style") {
        const css = markup.slice(scanned.end, end);
        const next = visit("css", css);
        if (next !== undefined && next !== css) {
          out += markup.slice(copied, scanned.end) + next;
          copied = end;
        }
      }
      i = end;
    }
  }
  return out + markup.slice(copied);
}

/** The relative references an HTML or SVG document loads files from (links are not loads). */
export function markupRefs(markup: string): string[] {
  const refs: string[] = [];
  walkMarkup(markup, (kind, value) => {
    if (kind === "css") refs.push(...cssRefs(value));
    else if (kind === "srcset") refs.push(...srcsetUrls(value));
    else if (kind === "url") refs.push(value);
    return undefined;
  });
  return refs;
}

/**
 * Image references of a Markdown document: `![alt](src)` with `src` bare or in `<…>` and an
 * optional `"title"`, `'title'` or `(title)`, and the HTML it embeds.
 */
export function markdownRefs(md: string): string[] {
  const refs: string[] = [];
  const bracket = seeker(md, (c) => c === 93);
  const angle = seeker(md, (c) => c === 62);
  const nonSpace = seeker(md, (c) => !jsSpace(c));
  const bareEnd = seeker(md, (c) => c === 41 || jsSpace(c));
  const closer: Record<number, (from: number) => number> = { 34: seeker(md, (c) => c === 34), 39: seeker(md, (c) => c === 39), 40: seeker(md, (c) => c === 41) };
  /** After a destination ending at `k`: an optional title after a space, spaces, `)`; the index after `)`, or -1. */
  const tail = (k: number): number => {
    const m = nonSpace(k);
    if (m < 0) return -1;
    const close = m > k ? closer[md.charCodeAt(m)] : undefined;
    if (close) {
      const t = close(m + 1);
      const e = t < 0 ? -1 : nonSpace(t + 1);
      if (e >= 0 && md.charCodeAt(e) === 41) return e + 1;
    }
    return md.charCodeAt(m) === 41 ? m + 1 : -1;
  };
  for (let i = 0; ; ) {
    const bang = md.indexOf("![", i);
    if (bang < 0) break;
    // Every `![` up to the next `]` shares this `]` and what follows it.
    const close = bracket(bang + 2);
    if (close < 0) break;
    i = close + 1;
    if (md.charCodeAt(close + 1) !== 40) continue;
    const j = nonSpace(close + 2);
    if (j < 0) break;
    let found: { ref: string; end: number } | undefined;
    if (md.charCodeAt(j) === 60) {
      const gt = angle(j + 1);
      const end = gt > j + 1 ? tail(gt + 1) : -1;
      if (end >= 0) found = { ref: md.slice(j + 1, gt), end };
    }
    if (!found) {
      const stop = bareEnd(j);
      const end = stop > j ? tail(stop) : -1;
      if (end >= 0) found = { ref: md.slice(j, stop), end };
    }
    if (found) {
      refs.push(found.ref.trim());
      i = found.end;
    }
  }
  return [...refs.filter(Boolean), ...markupRefs(md)];
}

function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/** A `data:` URL of an asset (stylesheets with their own references inlined). */
function inlineUrl(key: string, assets: ReadonlyMap<string, InlineAsset>, depth: number): string | undefined {
  const asset = assets.get(key);
  if (!asset) return undefined;
  if (asset.text === undefined) return `data:${asset.mime};base64,${asset.base64}`;
  const css = depth < ASSET_LIMITS.cssDepth ? rewriteCss(asset.text, (ref) => cssUrl(ref, keyDir(key), assets, depth + 1)) : asset.text;
  return `data:text/css;charset=utf-8;base64,${utf8Base64(css)}`;
}

function cssUrl(ref: string, base: string, assets: ReadonlyMap<string, InlineAsset>, depth: number): string | undefined {
  const key = assetKey(ref, base);
  return key === undefined ? undefined : withFragment(ref, inlineUrl(key, assets, depth));
}

/** Keeps a reference's `#fragment` (an SVG sprite's symbol) on its inlined URL. */
function withFragment(ref: string, url: string | undefined): string | undefined {
  if (!url) return undefined;
  const hash = ref.indexOf("#");
  return hash >= 0 ? url + ref.slice(hash) : url;
}

export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What inlines `assets` (keys relative to the document) into the references `walkMarkup` visits. */
function inliner(assets: ReadonlyMap<string, InlineAsset>): Visit {
  const one = (ref: string) => {
    const key = assetKey(ref);
    return key === undefined ? undefined : withFragment(ref, inlineUrl(key, assets, 0));
  };
  return (kind, value) => {
    if (kind === "rel") return undefined;
    if (kind === "url") return one(value);
    if (kind === "css") return rewriteCss(value, (ref) => cssUrl(ref, "", assets, 0));
    return value
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const [url = "", ...rest] = trimmed.split(/\s+/);
        const next = one(url);
        return next ? [next, ...rest].join(" ") : trimmed;
      })
      .join(", ");
  };
}

/** `markup` with every reference to one of `assets` (keys relative to the document) inlined. */
export function inlineAssets(markup: string, assets: ReadonlyMap<string, InlineAsset>): string {
  return assets.size ? walkMarkup(markup, inliner(assets)) : markup;
}

/** An HTML page's markup as it is shown and saved: references to `assets` inlined, resource hints dropped. */
function pageMarkup(html: string, assets: ReadonlyMap<string, InlineAsset>): string {
  const inline = assets.size ? inliner(assets) : undefined;
  return walkMarkup(html, (kind, value) => (kind === "rel" ? withoutHints(value) : inline?.(kind, value)));
}

/**
 * Where markup that must come before all of a document's own goes: right after its doctype when
 * the doctype comes first (after a byte order mark, whitespace, comments and `<?…>`, ended where
 * a browser ends them), so the document keeps its mode; else at the very start.
 */
function headAt(html: string): number {
  const start = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = start; ; ) {
    while (i < html.length && htmlSpace(html.charCodeAt(i))) i++;
    if (html.startsWith("<!--", i)) {
      i = commentEnd(html, i);
      continue;
    }
    const doctype = html.slice(i, i + 9).toLowerCase() === "<!doctype";
    if (doctype || html.startsWith("<?", i) || html.startsWith("<!", i)) {
      const gt = html.indexOf(">", i + 2);
      if (gt < 0) return start;
      if (doctype) return gt + 1;
      i = gt + 1;
      continue;
    }
    return start;
  }
}

/** Inserts `head` ahead of all of the document's own markup (after its doctype, see {@link headAt});
 *  the parser puts it into the document's head, before anything the page itself has there. */
export function injectHead(html: string, head: string): string {
  const at = headAt(html);
  return html.slice(0, at) + head + html.slice(at);
}

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(ARTIFACT_CSP)}"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off">`;

/** The artifact page as the inner frame shows it: references inlined, hints dropped, policy and prelude first. */
export function artifactDocument(html: string, assets: ReadonlyMap<string, InlineAsset>): string {
  return injectHead(pageMarkup(html, assets), `${POLICY_META}<script>${PAGE_GUARD}${LINK_CLICKS}</script>`);
}

/** The same page for a file the user saves or opens in their browser: inlined, hints dropped, the
 *  encoding, policy and {@link PAGE_GUARD} first; without the link prelude (its links work as links there). */
export function standaloneDocument(html: string, assets: ReadonlyMap<string, InlineAsset>): string {
  return injectHead(pageMarkup(html, assets), `<meta charset="utf-8">${POLICY_META}<script>${PAGE_GUARD}</script>`);
}

/** A page that shows an image (an SVG as `<img>`, where none of its scripts run) under the artifact
 *  policy: what Open in browser writes for a drawing. */
export function imageDocument(src: string, title: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">${POLICY_META}<title>${escapeAttr(title)}</title>` +
    `<style>html,body{margin:0;background:#fff}body{min-height:100vh;display:grid;place-items:center}img{max-width:100%;height:auto}</style>` +
    `</head><body><img src="${escapeAttr(src)}" alt="${escapeAttr(title)}"></body></html>`
  );
}

/** The wrapper frame's document around an artifact page (see the module comment); `sandbox`: the
 *  page frame's (scripts, or {@link STATIC_SANDBOX} on Android). */
export function wrapperDocument(inner: string, sandbox: string = FRAME_SANDBOX): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(ARTIFACT_CSP)}"><meta name="referrer" content="no-referrer">` +
    `<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>` +
    `</head><body><iframe sandbox="${sandbox}" referrerpolicy="no-referrer" title="Presented page" srcdoc="${escapeAttr(inner)}"></iframe></body></html>`
  );
}

/** What an artifact page's link message asks the app to open: an absolute http(s) URL, else undefined. */
export function linkTarget(data: unknown): { href: string; url?: string } | undefined {
  if (!data || typeof data !== "object" || !(LINK_MESSAGE in data) || !("open" in data)) return undefined;
  const href = data.open;
  if (typeof href !== "string" || !href || href.length > 8192) return undefined;
  let url: string | undefined;
  try {
    const u = new URL(href);
    url = u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    url = undefined;
  }
  return { href, url };
}

/** After a link prompt closes, how long further link messages are ignored. */
export const LINK_PROMPT_GAP_MS = 1500;

/**
 * Whether a page's link message may ask the user to open it: only while the user is using the page
 * itself (an activation, and the focus in its frame: typing in the composer activates the app's
 * window too, but leaves the focus outside the frame), and not before `quietUntil` (a page that
 * keeps asking). `userActive` undefined: the webview has no `navigator.userActivation`.
 */
export function linkPromptAllowed(s: { userActive?: boolean; frameFocused: boolean; now: number; quietUntil: number }): boolean {
  return s.userActive !== false && s.frameFocused && s.now >= s.quietUntil;
}
