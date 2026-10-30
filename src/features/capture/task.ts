/*
 * A task that comes in from outside the app's own composers: Android's share sheet (a screenshot,
 * a URL, a GitHub issue, text from any app) and the desktop Quick capture box. `prefill.ts` is the
 * one entry point that puts it in Dispatch (or, on request, in an agent's composer).
 */

/** An image as prompts carry it: base64 without the `data:` prefix. */
export interface TaskImage {
  mime: string;
  data: string;
  /** File name, when the source has one (Android shares). */
  name?: string;
}

export type TaskSource = "share" | "capture";

export interface PrefilledTask {
  text: string;
  images: TaskImage[];
  source: TaskSource;
  /** The repository it is about (`github.com/owner/repo`), from a shared issue or pull request link. */
  repo?: string;
}

export interface GithubRef {
  /** Canonical remote id, as Dispatch matches clones (`github.com/owner/repo`, lowercase). */
  repo: string;
  kind: "issue" | "pull";
  number: number;
}

const GITHUB_LINK = /\bhttps?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i;

/** The first GitHub issue or pull request link in `text`. */
export function githubRef(text: string): GithubRef | null {
  const m = GITHUB_LINK.exec(text);
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null;
  const name = m[2].replace(/\.git$/i, "");
  return { repo: `github.com/${m[1]}/${name}`.toLowerCase(), kind: m[3].toLowerCase() === "pull" ? "pull" : "issue", number: Number(m[4]) };
}

/** What Android's share sheet hands over (`EXTRA_TEXT`, `EXTRA_SUBJECT`). */
export interface SharedText {
  text?: string | null;
  subject?: string | null;
}

/**
 * The task text of a share: the subject (a page or issue title) above the text or link, without
 * repeating it, and the repository a GitHub issue or pull request link belongs to. A bare GitHub
 * link gets a line naming it ("GitHub issue owner/repo#12").
 */
export function composeShared(s: SharedText): { text: string; repo?: string } {
  const text = (s.text ?? "").trim();
  // Browsers share a page's title as the subject; GitHub's ends in " · GitHub".
  const subject = (s.subject ?? "").trim().replace(/\s*[·|–-]\s*GitHub$/i, "");
  const ref = githubRef(text) ?? githubRef(subject);
  const repo = ref ? { repo: ref.repo } : {};
  const bare = !/\s/.test(text) && /^https?:\/\//i.test(text);
  if (subject && !text.toLowerCase().includes(subject.toLowerCase())) {
    return { text: text ? `${subject}${bare ? "\n" : "\n\n"}${text}` : subject, ...repo };
  }
  if (ref && bare && !subject) {
    const [, owner, name] = ref.repo.split("/");
    return { text: `GitHub ${ref.kind === "pull" ? "pull request" : "issue"} ${owner}/${name}#${ref.number}\n${text}`, ...repo };
  }
  return { text, ...repo };
}

/**
 * `incoming` added to a draft: appended after a blank line, never twice (a share repeated, or a
 * task the draft already says).
 */
export function mergeDraftText(existing: string, incoming: string): string {
  const add = incoming.trim();
  if (!add) return existing;
  if (!existing.trim()) return add;
  if (existing.includes(add)) return existing;
  return `${existing.trimEnd()}\n\n${add}`;
}

/** Image files from base64 payloads (Android shares), so they go through the same scaling as pasted ones. */
export function imageFilesOf(images: readonly TaskImage[]): File[] {
  return images.map((img, i) => {
    const bin = atob(img.data);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    return new File([bytes], img.name || `shared-${i + 1}.${img.mime.split("/")[1] ?? "png"}`, { type: img.mime });
  });
}

/** "2 images", "1 image", "" — what a task carries besides text. */
export function imagesLabel(n: number): string {
  return n === 0 ? "" : n === 1 ? "1 image" : `${n} images`;
}
