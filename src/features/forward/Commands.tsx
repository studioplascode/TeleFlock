import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/design";
import { copyText } from "@/features/hosts/CopyCommand";
import type { Snippets } from "./model";

/** One line to copy: what it is, the text (wraps, selectable), and the copy button. */
function CopyLine({ label, text, what, note }: { label: ReactNode; text: string; what: string; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-2xs font-bold text-mute">{label}</div>
      <div className="flex min-w-0 items-start gap-1 well rounded-md py-1.5 pr-1 pl-2.5 shadow-hairline">
        <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-2 select-text">{text}</code>
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-xs text-mute pressable focus-ring hover:bg-ink/10 hover:text-ink"
          aria-label={`Copy ${what}`}
          title="Copy"
          onClick={() => copyText(text, what.charAt(0).toUpperCase() + what.slice(1))}
        >
          <Copy className="size-3.5" />
        </button>
      </div>
      {note && <p className="text-2xs text-mute-2">{note}</p>}
    </div>
  );
}

/**
 * How to use a rule from its from-host: the exact commands, the PATH line for a shell started by hand (tools and
 * `tf-forward`; agents TeleFlock launches already have it, unless `~/.bashrc` on a Unix from-host sets PATH
 * outright) or `tf-forward`'s full path, how each port is reached, and the paragraph to give an agent.
 */
export function Commands({ snippets, fromName, toName, fromWindows, toWindows, className }: { snippets: Snippets; fromName: string; toName: string; fromWindows?: boolean; toWindows?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {snippets.run && snippets.shell && (
        <>
          <CopyLine label={`Run a command on ${toName}, from ${fromName}`} text={snippets.run} what="command" note="Words after -- run in the login shell of the user on that host; the exit status comes back." />
          <CopyLine
            label={`Open a shell on ${toName}`}
            text={snippets.shell}
            what="shell command"
            note={toWindows ? "Windows hosts run commands over plain pipes, not a terminal." : undefined}
          />
        </>
      )}
      {snippets.pathLine && (
        <CopyLine
          label={snippets.tools.length > 0 ? `${snippets.tools.join(", ")} run${snippets.tools.length === 1 ? "s" : ""} on ${toName} when called by name on ${fromName}` : `tf-forward in a shell you start yourself on ${fromName}`}
          text={snippets.pathLine}
          what="PATH line"
          note={<>Agents TeleFlock starts after {fromName} updated to TeleFlock 0.8.0 have this; agents already running keep their old bridge until restarted (Mark done, then Resume). Add the line to a shell you started yourself (or to its profile){snippets.tfForwardPath ? <>, or call <code className="font-mono">{snippets.tfForwardPath}</code> by its full path</> : null}.{snippets.tools.length > 0 ? <>{fromWindows ? null : <> omp's bash tool reads <code className="font-mono">~/.bashrc</code> on {fromName}: if it sets PATH outright (without <code className="font-mono">$PATH</code>), add the line right after that, or agents there will not find these tools by name.</>} Tools start in your home folder on {toName}, not the folder they are called from{snippets.shell ? <>; <code className="font-mono">--cwd DIR</code> on a <code className="font-mono">tf-forward</code> command picks another</> : null}.</> : null}</>}
        />
      )}
      {snippets.ports.map((p) => (
        <CopyLine key={p.listen} label={p.meaning} text={p.example} what="command" />
      ))}
      <CopyLine
        label="Give an agent"
        text={snippets.instruction}
        what="instruction"
        note="Paste it into the agent's prompt, or into its AGENTS.md on the from-host."
      />
    </div>
  );
}
