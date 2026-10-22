/** Titles omp uses for every dialog of a kind; the real question is then in the message. */
const GENERIC_TITLE = /^(question|ask|input|confirm|continue\??)$/i;

/**
 * Headline and body for a pending request, each fact once: a generic title ("Question",
 * "Continue?") gives way to the message, and an approval's command is left to the code block
 * that shows it (as are omp's "Allow tool: bash" lines, which repeat the title).
 */
export function askText(input: { title: string; message?: string; command?: string; approval?: boolean }): { headline: string; body: string | null } {
  const title = input.title.trim();
  const command = input.command?.trim() || undefined;
  const message = (input.message ?? "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(command && t === command) && !(input.approval && /^allow tool:/i.test(t));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const titleIsCommand = !!command && title.includes(command);
  if (!title || GENERIC_TITLE.test(title) || titleIsCommand) {
    if (message) return { headline: message, body: null };
    return { headline: titleIsCommand || !title ? (input.approval ? "Allow this command?" : "") : title, body: null };
  }
  return { headline: title, body: message && message !== title ? message : null };
}
