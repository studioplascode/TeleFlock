import { Check, Copy, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { IconButton, cn } from "@/design";

export interface PreviewLine {
  /** argv, already shell-quoted per element. */
  argv: string[];
  /** Comment shown above the command. */
  note?: string;
}

/** What TeleFlock will run on the host, rendered like a shell transcript with a copy button. */
export function CommandPreview({ lines, className }: { lines: PreviewLine[]; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = lines.map((l) => `${l.note ? `# ${l.note}\n` : ""}${l.argv.join(" ")}`).join("\n");
  return (
    <div className={cn("relative rounded-lg bg-bg-deep p-3.5 pr-11 shadow-[inset_0_0_0_1px_var(--color-line-2)]", className)}>
      <div className="mb-2 flex items-center gap-1.5">
        <TerminalSquare className="size-3.5 text-mute-2" />
        <span className="kicker">Command preview</span>
      </div>
      <IconButton
        label={copied ? "Copied" : "Copy commands"}
        size="sm"
        className="absolute top-2.5 right-2.5"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check className="text-done" /> : <Copy />}
      </IconButton>
      <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.65] whitespace-pre-wrap text-ink-2">
        {lines.map((l, i) => (
          <span key={i} className="block">
            {l.note && <span className="block text-mute-2"># {l.note}</span>}
            <span className="text-mute-2 select-none">$ </span>
            {l.argv.map((a, j) => (
              <span key={j}>
                {j > 0 && " "}
                <span className={cn(j === 0 ? "font-bold text-accent-hi" : a === "--" ? "text-mute" : a.startsWith("-") ? "text-omp-blue" : "text-ink")}>{a}</span>
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}
