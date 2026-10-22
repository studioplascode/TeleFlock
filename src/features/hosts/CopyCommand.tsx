import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { cn, toast } from "@/design";
import { linkProps } from "@/core";

/** A link to a project site, opened in the system browser (never navigates the webview). */
export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const props = linkProps(href);
  if (!props) return <>{children}</>;
  return (
    <a {...props} className={cn("rounded-xs font-semibold text-accent-hi underline decoration-accent-hi/40 underline-offset-2 focus-ring hover:decoration-accent-hi", className)}>
      {children}
    </a>
  );
}

/** Copy text to the clipboard with a short confirmation toast. */
export function copyText(text: string, what = "Command"): void {
  navigator.clipboard.writeText(text).then(
    () => toast({ title: `${what} copied`, description: text, status: "done", duration: 2200 }),
    () => toast({ title: `Couldn't copy the ${what.toLowerCase()}`, status: "error" }),
  );
}

/** A shell command in mono with a copy button beside it (prerequisites and fixes). */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-xs bg-black/30 py-0.5 pr-0.5 pl-1.5 align-middle", className)}>
      <code className="min-w-0 truncate font-mono text-2xs text-ink-2" title={command}>
        {command}
      </code>
      <button
        type="button"
        className="grid size-5 shrink-0 place-items-center rounded-xs text-mute pressable focus-ring hover:bg-white/10 hover:text-ink"
        aria-label={`Copy ${command}`}
        title="Copy"
        onClick={(e) => {
          e.stopPropagation();
          copyText(command);
        }}
      >
        <Copy className="size-3" />
      </button>
    </span>
  );
}
