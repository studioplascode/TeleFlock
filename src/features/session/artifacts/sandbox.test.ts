import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CSP,
  artifactDocument,
  assetKey,
  cssRefs,
  FRAME_SANDBOX,
  imageDocument,
  type InlineAsset,
  inlineAssets,
  injectHead,
  linkPromptAllowed,
  linkTarget,
  markdownRefs,
  markupRefs,
  PAGE_GUARD,
  rewriteCss,
  standaloneDocument,
  STATIC_SANDBOX,
  utf8Base64,
  wrapperDocument,
} from "./sandbox";

const asset = (mime: string, text: string): InlineAsset => ({ mime, base64: utf8Base64(text), ...(mime === "text/css" ? { text } : {}) });
const decode = (dataUrl: string) => new TextDecoder().decode(Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0)));

/** The srcdoc of the wrapper's frame, unescaped (what the inner frame renders). */
function innerOf(wrapper: string): string {
  const m = /<iframe ([^>]*)srcdoc="([^"]*)"><\/iframe>/.exec(wrapper);
  if (!m) throw new Error("no inner frame");
  return m[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * A stand-in for the DOM interfaces {@link PAGE_GUARD} wraps, shaped like the real ones: accessors
 * and methods on the prototypes, and the "engine" (token lists, attribute storage) writing
 * attributes directly, never through what a page can call.
 */
function standInWindow() {
  class Node {
    declare nodeValue: string | null;
    declare textContent: string | null;
  }
  class Attr extends Node {
    declare value: string;
    ownerElement: Element | null = null;
    raw = "";
    constructor(
      readonly name: string,
      readonly namespaceURI: string | null = null,
    ) {
      super();
    }
  }
  Object.defineProperty(Attr.prototype, "value", {
    get(this: Attr) {
      return this.raw;
    },
    set(this: Attr, v: unknown) {
      this.raw = String(v);
    },
    configurable: true,
  });
  for (const k of ["nodeValue", "textContent"])
    Object.defineProperty(Node.prototype, k, {
      get(this: Node) {
        return this instanceof Attr ? this.raw : null;
      },
      set(this: Node, v: unknown) {
        if (this instanceof Attr) this.raw = String(v);
      },
      configurable: true,
    });
  class NamedNodeMap {
    constructor(readonly owner: Element) {}
    setNamedItem(a: Attr) {
      return this.owner.attach(a);
    }
  }
  class Element extends Node {
    declare attributes: NamedNodeMap;
    readonly attrs = new Map<string, Attr>();
    readonly map = new NamedNodeMap(this);
    attach(a: Attr): null {
      a.ownerElement = this;
      this.attrs.set(a.name.toLowerCase(), a);
      return null;
    }
    write(name: string, value: string) {
      const a = new Attr(name);
      a.raw = value;
      this.attach(a);
    }
    getAttribute(name: string) {
      return this.attrs.get(name.toLowerCase())?.raw ?? null;
    }
    setAttribute(...args: unknown[]) {
      if (args.length < 2) throw new TypeError("2 arguments required");
      this.write(String(args[0]).toLowerCase(), String(args[1]));
    }
    setAttributeNS(_ns: string | null, name: string, value: unknown) {
      this.write(name, String(value));
    }
    setAttributeNode(a: Attr) {
      return this.attach(a);
    }
  }
  Object.defineProperty(Element.prototype, "attributes", {
    get(this: Element) {
      return this.map;
    },
    configurable: true,
  });
  class DOMTokenList {
    declare value: string;
    constructor(readonly owner: Element) {}
    tokens() {
      return (this.owner.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean);
    }
    add(...tokens: string[]) {
      const s = this.tokens();
      for (const t of tokens) if (!s.includes(t)) s.push(t);
      this.owner.write("rel", s.join(" "));
    }
    toggle(token: string) {
      const s = this.tokens();
      const has = s.includes(token);
      this.owner.write("rel", (has ? s.filter((t) => t !== token) : [...s, token]).join(" "));
      return !has;
    }
    replace(old: string, token: string) {
      const s = this.tokens();
      const i = s.indexOf(old);
      if (i < 0) return false;
      s[i] = token;
      this.owner.write("rel", s.join(" "));
      return true;
    }
  }
  Object.defineProperty(DOMTokenList.prototype, "value", {
    get(this: DOMTokenList) {
      return this.owner.getAttribute("rel") ?? "";
    },
    set(this: DOMTokenList, v: unknown) {
      this.owner.write("rel", String(v));
    },
    configurable: true,
  });
  class HTMLLinkElement extends Element {
    declare rel: string;
    declare relList: DOMTokenList;
    readonly list = new DOMTokenList(this);
  }
  Object.defineProperty(HTMLLinkElement.prototype, "rel", {
    get(this: HTMLLinkElement) {
      return this.getAttribute("rel") ?? "";
    },
    set(this: HTMLLinkElement, v: unknown) {
      this.write("rel", String(v));
    },
    configurable: true,
  });
  Object.defineProperty(HTMLLinkElement.prototype, "relList", {
    get(this: HTMLLinkElement) {
      return this.list;
    },
    configurable: true,
  });
  const peer = () => undefined;
  return { RTCPeerConnection: peer as unknown, webkitRTCPeerConnection: peer as unknown, HTMLLinkElement, Element, Attr, Node, NamedNodeMap, DOMTokenList };
}

describe("the sandbox", () => {
  test("no network, no frames, no navigation targets, no forms, no base", () => {
    const d = new Map(ARTIFACT_CSP.split("; ").map((p) => [p.split(" ")[0]!, p.split(" ").slice(1)] as const));
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("connect-src")).toEqual(["'none'"]);
    expect(d.get("frame-src")).toEqual(["'none'"]);
    expect(d.get("child-src")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    // what may load at all comes from the document itself
    for (const sources of d.values()) for (const s of sources) expect(["'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:"]).toContain(s);
    expect(FRAME_SANDBOX).toBe("allow-scripts");
  });

  test("the wrapper: policy first, the page in a sandboxed srcdoc frame, nothing able to break out of the attribute", () => {
    const page = `<!doctype html><title>x</title><p>"quoted" & <b>bold</b></p><script>alert("</iframe><script>top.x=1</script>")</script>`;
    const w = wrapperDocument(page);
    expect(w.startsWith("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(w).toContain(`content="${ARTIFACT_CSP.replace(/'/g, "'")}"`);
    const frames = w.match(/<iframe /g) ?? [];
    expect(frames).toHaveLength(1);
    expect(w).toMatch(/<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="Presented page" srcdoc="/);
    expect(w).not.toContain("allow-same-origin");
    expect(innerOf(w)).toBe(page);
    // the page's own markup never closes the attribute or the frame
    expect(w.slice(w.indexOf("srcdoc=")).split('"')).toHaveLength(3);
    // Android: the page frame runs no scripts at all
    const still = wrapperDocument(page, STATIC_SANDBOX);
    expect(still).toMatch(/<iframe sandbox="" referrerpolicy="no-referrer"/);
    expect(innerOf(still)).toBe(page);
  });

  test("the artifact page: policy, no referrer, no DNS prefetch and the prelude ahead of all of its own markup", () => {
    const page = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><script>evil()</script></head><body></body></html>`;
    const doc = artifactDocument(page, new Map());
    expect(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const head = doc.slice(0, doc.indexOf("evil()"));
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(head).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
    expect(head).toContain('addEventListener("click"');
    expect(head).toContain('"RTCPeerConnection"');
    // the page itself follows as written
    expect(doc.endsWith(page.slice("<!DOCTYPE html>".length))).toBe(true);
    // a saved copy: the encoding, the policy and the guard first, no link prelude (links work as links there)
    const saved = standaloneDocument(page, new Map());
    expect(saved.startsWith('<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(saved.slice(0, saved.indexOf("evil()"))).toContain('"RTCPeerConnection"');
    expect(saved).not.toContain('addEventListener("click"');
  });

  test("nothing of the page comes before the policy: a head in a comment or a script, comments ended as browsers end them", () => {
    const at = (page: string) => injectHead(page, "<M>");
    // no doctype first: the very start (after a byte order mark)
    for (const page of [
      `<!--<head>--><script>evil()</script><head><title>x</title></head>`,
      `<script>evil()</script><head></head>`,
      `<!-- --!><script>evil()</script><!-- --><!doctype html><head></head>`,
      `<!--><script>evil()</script>--><!doctype html><head></head>`,
      `<!---><script>evil()</script><!---->`,
      `<?xml version="1.0"?><script>evil()</script><!doctype html>`,
      `<svg><head/></svg><script>evil()</script>`,
      `<html><body>x`,
      `<HEAD data-x='1'><title>t</title>`,
      `<p>x`,
    ])
      expect(at(page)).toBe(`<M>${page}`);
    expect(at(`\uFEFF  <script>evil()</script>`)).toBe(`\uFEFF<M>  <script>evil()</script>`);
    // right after a doctype that comes first (whitespace, comments and `<?…>` before it), so the mode stays
    expect(at(`<!doctype html><script>var s = "<head>"; evil()</script><head></head>`)).toBe(`<!doctype html><M><script>var s = "<head>"; evil()</script><head></head>`);
    expect(at(` \n<!-- <script>x()</script> --!><?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html>`)).toBe(
      ` \n<!-- <script>x()</script> --!><?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><M><html>`,
    );
    expect(at(`<!---->\n<!doctype html><p>x`)).toBe(`<!---->\n<!doctype html><M><p>x`);
    // both copies put the policy and the guard there
    for (const make of [artifactDocument, standaloneDocument]) {
      const doc = make(`<!--<head>--><script>evil()</script><head></head>`, new Map());
      expect(doc.startsWith("<meta")).toBe(true);
      expect(doc.indexOf('"RTCPeerConnection"')).toBeLessThan(doc.indexOf("evil()"));
    }
  });

  test("resource hints in the page's markup are dropped (CSP stops none of them); script text and other elements stay", () => {
    const page =
      `<!doctype html><head><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="dns-prefetch" href="//x.example">` +
      `<link rel="stylesheet PreLoad" href="a.css"><LINK REL=prerender href=y><link rel='prefetch modulepreload' href=z><link rel="icon" href="fav.png">` +
      `<link rel="&#112;reconnect" href=//p><link rel="stylesheet&Tab;preconnect" href=//q><link rel="pre&#99onnect" href=//r><link rel="a&Unknown;b" href=//s>` +
      `</head><body><a rel="prefetch" href="q">q</a><script>const s = '<link rel="preconnect" href="//in-script">';</script></body>`;
    const rels = (doc: string) => [...doc.matchAll(/<link\b[^>]*?\brel=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi)].map((m) => m[1] ?? m[2] ?? m[3]);
    const expected = ["", "", "stylesheet PreLoad", "", "", "icon", "", "stylesheet", "", "", "preconnect"];
    for (const assets of [new Map<string, InlineAsset>(), new Map([["fav.png", asset("image/png", "PNG")]])]) {
      for (const doc of [artifactDocument(page, assets), standaloneDocument(page, assets)]) {
        expect(rels(doc)).toEqual(expected);
        expect(doc).toContain(`<a rel="prefetch" href="q">`);
      }
    }
    expect(decode(/<link rel="icon" href="([^"]+)"/.exec(artifactDocument(page, new Map([["fav.png", asset("image/png", "PNG")]])))![1]!)).toBe("PNG");
  });

  test("the guard: the page's scripts can't add resource hints through the DOM or reach WebRTC (run on a stand-in DOM)", () => {
    const w = standInWindow();
    new Function("window", PAGE_GUARD)(w);
    expect(w.RTCPeerConnection).toBeUndefined();
    expect(w.webkitRTCPeerConnection).toBeUndefined();
    expect(Reflect.set(w, "RTCPeerConnection", () => 0)).toBe(false);
    expect(Reflect.defineProperty(w, "RTCPeerConnection", { value: () => 0 })).toBe(false);
    const { HTMLLinkElement: Link, Element, Attr } = w;
    const link = new Link();
    const rel = () => link.getAttribute("rel");
    link.rel = "preconnect stylesheet";
    expect(rel()).toBe("stylesheet");
    link.setAttribute("REL", "dns-prefetch icon");
    expect(rel()).toBe("icon");
    link.setAttributeNS(null, "rel", "prerender");
    expect(rel()).toBe("");
    link.relList.add("prefetch", "alternate");
    expect(rel()).toBe("alternate");
    expect(link.relList.toggle("preconnect")).toBe(false);
    expect(link.relList.replace("alternate", "dns-prefetch")).toBe(false);
    expect(rel()).toBe("alternate");
    link.relList.value = "modulepreload author";
    expect(rel()).toBe("author");
    const a = new Attr("rel");
    a.value = "preconnect";
    link.setAttributeNode(a);
    expect(rel()).toBe("");
    a.value = "preconnect help";
    expect(rel()).toBe("help");
    a.nodeValue = "dns-prefetch";
    expect(rel()).toBe("");
    a.textContent = "prefetch license";
    expect(rel()).toBe("license");
    const b = new Attr("rel");
    b.value = "prerender search";
    link.attributes.setNamedItem(b);
    expect(rel()).toBe("search");
    // other attributes and other elements keep what they are given
    link.setAttribute("title", "preconnect");
    expect(link.getAttribute("title")).toBe("preconnect");
    const div = new Element();
    div.setAttribute("rel", "preconnect");
    expect(div.getAttribute("rel")).toBe("preconnect");
    expect(() => link.setAttribute("rel")).toThrow();
  });

  test("link messages: only absolute http(s) URLs open", () => {
    expect(linkTarget({ tfArtifact: 1, open: "https://example.com/q3?x=1" })).toEqual({ href: "https://example.com/q3?x=1", url: "https://example.com/q3?x=1" });
    expect(linkTarget({ tfArtifact: 1, open: "details.html" })).toEqual({ href: "details.html", url: undefined });
    expect(linkTarget({ tfArtifact: 1, open: "javascript:alert(1)" })?.url).toBeUndefined();
    expect(linkTarget({ tfArtifact: 1, open: "file:///etc/passwd" })?.url).toBeUndefined();
    expect(linkTarget({ open: "https://x" })).toBeUndefined();
    expect(linkTarget({ tfArtifact: 1, open: 42 })).toBeUndefined();
    expect(linkTarget("https://x")).toBeUndefined();
    expect(linkTarget(null)).toBeUndefined();
  });

  test("a link message asks only while the user is in the page's frame, and not again right after a prompt", () => {
    const allowed = (s: Partial<Parameters<typeof linkPromptAllowed>[0]>) => linkPromptAllowed({ userActive: true, frameFocused: true, now: 10_000, quietUntil: 0, ...s });
    expect(allowed({})).toBe(true);
    // typing in the composer activates the app's window too; the focus is outside the frame then
    expect(allowed({ frameFocused: false })).toBe(false);
    // a script posting by itself
    expect(allowed({ userActive: false })).toBe(false);
    // a page that asks again as soon as the prompt closed
    expect(allowed({ quietUntil: 10_001 })).toBe(false);
    // a webview without navigator.userActivation: the focus alone decides
    expect(allowed({ userActive: undefined })).toBe(true);
  });

  test("Open in browser shows a drawing as an image under the policy", () => {
    const page = imageDocument('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E', 'Logo "v2" <draft>');
    expect(page.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(page).toContain(`<img src="data:image/svg+xml;charset=utf-8,%3Csvg%3E`);
    expect(page).toContain(`<title>Logo &quot;v2&quot; &lt;draft&gt;</title>`);
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<svg");
  });
});

describe("references", () => {
  test("keys inside the document's folder", () => {
    expect(assetKey("img/a.png?v=2#x")).toBe("img/a.png");
    expect(assetKey("./img/../img/a%20b.png")).toBe("img/a b.png");
    expect(assetKey("../bg.png", "css")).toBe("bg.png");
    expect(assetKey("theme.css", "css")).toBe("css/theme.css");
    for (const ref of ["../a.png", "/a.png", "//cdn.x/a.png", "https://x/a.png", "data:image/png;base64,AA", "#frag", "c:/x.png", "a\\b.png", "", "x/../.."]) {
      expect(assetKey(ref)).toBeUndefined();
    }
  });

  test("what a page loads: not links, comments or script text", () => {
    const html = `<link rel="stylesheet" href="css/site.css"><link rel="preconnect" href="https://f.example"><link rel=icon href=fav.png>
<script src="js/app.js"></script><script>const s = '<img src="in-script.png">';</script><!-- <img src="commented.png"> -->
<style>.a{background:url( 'img/a.png' )} @import "more.css";</style>
<img src="chart.png" srcset="chart.png 1x, chart@2x.png 2x" style="background-image:url(bg.png)"><video poster="poster.jpg"><source src="clip.mp4"></video>
<a href="details.html">x</a><iframe src="frame.html"></iframe><svg><image href="pic.png"/><use xlink:href="sprite.svg#i"/></svg>`;
    expect(markupRefs(html)).toEqual(["css/site.css", "fav.png", "js/app.js", "img/a.png", "more.css", "chart.png", "chart.png", "chart@2x.png", "bg.png", "poster.jpg", "clip.mp4", "pic.png", "sprite.svg#i"]);
    expect(cssRefs(`/* url(no.png) */ a { background: url("x.png") } @import 'y.css';`)).toEqual(["x.png", "y.css"]);
    expect(markdownRefs(`![chart](img/c.png "Chart") ![](<my file.png>) [doc](d.md) <img src="raw.png">`)).toEqual(["img/c.png", "my file.png", "raw.png"]);
  });

  test("tags where a browser finds them: comments as it ends them, text elements, end tags, noscript", () => {
    const html =
      `<!--><img src="after-empty-comment.png">--><!-- x --!><img src="after-bang-comment.png"><!-- y -->` +
      `<textarea><img src="in-textarea.png"></textarea><title><img src=in-title.png></title><TITLE>t</TITLE>` +
      `</p title="<img src=in-end-tag.png>"><noscript><img src="in-noscript.png"></noscript><svg><title>a</title><image href="svg.png"/></svg>`;
    expect(markupRefs(html)).toEqual(["after-empty-comment.png", "after-bang-comment.png", "in-noscript.png", "svg.png"]);
    // a tag that never ends ends the walk (a browser drops it with everything after it)
    expect(markupRefs(`<img src="a.png"><img src="b.png"`)).toEqual(["a.png"]);
    expect(markupRefs(`<img src="a.png"><img alt='never closed><img src="c.png">`)).toEqual(["a.png"]);
    // Markdown images: bare or <…> sources, the three title forms, spaces inside
    expect(markdownRefs(`![a](b.png 'B') ![a]( <c d.png> ) ![a](e.png (E)) ![a](f.png "F" ) ![a](g.png "never closed) ![a](<h>i.png)`)).toEqual([
      "b.png",
      "c d.png",
      "e.png",
      "f.png",
      "<h>i.png",
    ]);
    expect(cssRefs(`a{b:url( "q r.png" )} c{d:url(s.png )} e{f:url(t u.png)} /* never closed url(v.png)`)).toEqual(["q r.png", "s.png"]);
    expect(rewriteCss(`a{b:URL(x.png)} c{d:url("y.png")} @import 'z.css';`, (ref) => (ref === "z.css" ? undefined : `data:,${ref}`))).toBe(
      `a{b:url("data:,x.png")} c{d:url("data:,y.png")} @import 'z.css';`,
    );
  });

  test("inlining: files become data URLs, stylesheets with their own references, the rest stays", () => {
    const assets = new Map<string, InlineAsset>([
      ["chart.png", asset("image/png", "PNG")],
      ["css/site.css", asset("text/css", `@import "theme.css"; body { background: url(../img/bg.png) }`)],
      ["css/theme.css", asset("text/css", `h1 { color: red }`)],
      ["img/bg.png", asset("image/png", "BG")],
      ["js/app.js", asset("text/javascript", "go()")],
    ]);
    const html = `<head><link rel="stylesheet" href="css/site.css?v=2"></head><img src="chart.png" alt='a "b"' srcset="chart.png 1x, missing.png 2x"><img src="https://cdn.example/x.png"><script src="js/app.js"></script><p style="background:url('chart.png')">x</p>`;
    const out = inlineAssets(html, assets);
    const attr = (name: string, n = 0) => [...out.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))][n]?.[1];
    expect(decode(attr("src") ?? "")).toBe("PNG");
    expect(out).toContain(`alt='a "b"'`);
    expect(attr("srcset")).toMatch(/^data:image\/png;base64,UE5H 1x, missing\.png 2x$/);
    expect(out).toContain(`src="https://cdn.example/x.png"`);
    expect(decode(attr("src", 2) ?? "")).toBe("go()");
    const css = decode(attr("href") ?? "");
    expect(css).toContain(`body { background: url("data:image/png;base64,${btoa("BG")}") }`);
    expect(css).toMatch(/^@import url\("data:text\/css;charset=utf-8;base64,[^"]+"\);/);
    expect(decode(/@import url\("([^"]+)"\)/.exec(css)![1]!)).toBe("h1 { color: red }");
    expect(out).toContain(`style="background:url(&quot;data:image/png;base64,${btoa("PNG")}&quot;)"`);
    // nothing to inline: the markup is untouched
    expect(inlineAssets(html, new Map())).toBe(html);
  });
});

describe("agent-written markup that never ends takes linear time", () => {
  const within = (ms: number, run: () => unknown) => {
    const t = performance.now();
    run();
    expect(performance.now() - t).toBeLessThan(ms);
  };
  const n = 60_000;

  test("pages, stylesheets and Markdown", () => {
    within(1500, () => markupRefs("<x".repeat(n)));
    within(1500, () => markupRefs('<a b="'.repeat(n)));
    within(1500, () => artifactDocument(`<p a="${"<b ".repeat(n)}`, new Map()));
    within(1500, () => markdownRefs("![".repeat(n)));
    within(1500, () => markdownRefs("![a](b".repeat(n)));
    within(1500, () => markdownRefs("![a](<b (".repeat(n)));
    within(1500, () => markdownRefs(`![a](<${"![b](c (d ".repeat(n)}> (e`));
    within(1500, () => cssRefs("/*a".repeat(n)));
    within(1500, () => cssRefs("url(".repeat(n)));
    within(1500, () => cssRefs("url(a".repeat(n)));
    within(1500, () => rewriteCss("url( 'a".repeat(n), () => "data:,x"));
  });
});
