import type { FileDiff } from "@/core/gen";
import { say, type Step } from "./scripts";

/*
 * The docs session's rich transcript: Mermaid diagrams (one that doesn't parse), math next to
 * prices and shell variables, an SVG fence, and written .svg / .mmd / .md files that the tool card
 * previews (richContent.test.ts keeps them in step with the renderer's expectations).
 */

export const FLOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">
  <defs>
    <linearGradient id="omp" x1="0" x2="1">
      <stop offset="0" stop-color="#f053d0"/>
      <stop offset=".55" stop-color="#a15eef"/>
      <stop offset="1" stop-color="#7fa2e7"/>
    </linearGradient>
  </defs>
  <rect width="240" height="120" rx="14" fill="#14141f"/>
  <g fill="none" stroke="url(#omp)" stroke-width="4" stroke-linecap="round">
    <path d="M30 78 q14 -26 28 0 q14 -26 28 0"/>
    <path d="M92 52 q14 -26 28 0 q14 -26 28 0"/>
    <path d="M150 84 q14 -26 28 0 q14 -26 28 0"/>
  </g>
  <text x="120" y="108" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#9a9aad">flock of three</text>
</svg>`;

const FLOW_MMD = `flowchart TD
  prompt([Prompt]) --> route{Which host?}
  route -->|forge| forge[tf-hostd on forge]
  route -->|laptop| laptop[tf-hostd on laptop]
  forge --> omp[omp session]
  laptop --> omp
  omp --> review[[Review diff]]
  review -->|approve| merge([Merge])
  review -->|changes| omp`;

const ARCHITECTURE_MD = `# Architecture overview

## Request path

\`\`\`mermaid
sequenceDiagram
  participant App
  participant Hostd as tf-hostd
  participant Omp as omp
  App->>Hostd: session.open
  Hostd->>Omp: attach
  Omp-->>Hostd: transcript delta
  Hostd-->>App: event
\`\`\`

## Capacity

A pool of $c$ connections serves \\(\\lambda\\) requests per second at utilisation $\\rho = \\lambda / (c\\mu)$.
`;

/** A write call as omp's collab replica shows it: one hunk adding the whole file. */
export function written(path: string, content: string, lang?: string): Step {
  const lines = content.replace(/\n$/, "").split("\n");
  const file: FileDiff = { path, patch: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`, added: lines.length, removed: 0, status: "modified", lang };
  return { t: "tool", spec: { tool: "write", title: path, args: { path, content }, ms: 700, view: { type: "diff", files: [file] } } };
}

export const RICH_TEXT = `Here is how a prompt travels, as a flowchart:

\`\`\`mermaid
flowchart LR
  App[TeleFlock app] -->|WebSocket| Hostd[tf-hostd]
  Hostd --> Herdr[herdr]
  Herdr --> Omp[omp agent]
  Omp -->|bridge| Hostd
  Hostd -->|events| App
\`\`\`

And the reconnect handshake, as a sequence diagram:

\`\`\`mermaid
sequenceDiagram
  participant A as App
  participant H as tf-hostd
  A->>H: hello(sessionId)
  H-->>A: snapshot + cursor
  loop every 5 s
    A->>H: ping
    H-->>A: pong
  end
  Note over A,H: a missed pong starts the reconnect
\`\`\`

Sizing the pool follows Little's law, $L = \\lambda W$: at $\\lambda = 120$ requests per second and $W = 45$ ms about $5.4$ connections are busy. The tail is $p_{99} \\approx \\mu + 2.33\\,\\sigma$, and utilisation is

$$
\\rho = \\frac{\\lambda}{c\\,\\mu} \\qquad \\sum_{k=0}^{n} \\binom{n}{k} = 2^n
$$

Prices and shell variables stay text: the Pro plan costs $5 and Team is $10 per seat, \`echo $HOME\` is code, and so is $HOME/$USER in a sentence.

A sketch of the logo as an SVG:

\`\`\`svg
${FLOCK_SVG}
\`\`\`

This one has a typo, so it shows its source and the reason:

\`\`\`mermaid
flowchart LR
  A[Start --> B{
\`\`\`
`;

export function richContentSteps(): Step[] {
  return [
    written("docs/img/flock.svg", FLOCK_SVG, "xml"),
    written("docs/flow.mmd", FLOW_MMD),
    written("docs/architecture.md", ARCHITECTURE_MD, "markdown"),
    say(RICH_TEXT),
  ];
}
