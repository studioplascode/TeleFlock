/*
 * Chat tasks on the demo host (architecture §3.31, `@/core/chats`): an omp agent with no repository or
 * folder of the user's, like a chat app with omp's tools. forge's daemon starts them (`HostInfo.chats`):
 * each chat gets an empty folder `<home>/.teleflock/chats/<name>-<id>/` and a tab of the host's one
 * `Chats` workspace (host.ts), and its prompts get conversational replies (`chatTurn`). This module keeps
 * the folders and what is in them (`.omp/…` is omp's own, anything else keeps the folder), names chats,
 * and answers `chat.list` / `chat.delete` as tf-hostd does. studio-pc plays a daemon before chats: no
 * `HostInfo.chats`, the chat target doesn't parse (`chatTargetRefused`), `chat.*` is an unknown method.
 */
import type { ChatDeletion, ChatFolder, ChatFolders, PastSession, WebSource } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import { type AgentDef, HOME } from "./data";
import { Rng } from "./rng";
import { say, type Step, think } from "./scripts";

/** `HostInfo.chats` of the demo hosts whose daemon starts chats: where chat folders live. */
export const CHATS = `${HOME}/.teleflock/chats`;

const DAY = 86_400_000;
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** One file in a chat folder; `path` is relative to the folder (`.omp/…`: omp's own). */
interface ChatFile {
  path: string;
  /** Last written. */
  at: number;
  text: string;
}

interface ChatDir {
  folder: string;
  /** The folder's own modification time. */
  at: number;
  files: ChatFile[];
}

/** What the chats need from their demo host. */
export interface ChatsHost {
  now(): number;
  /** Every agent on the board, parked and ended ones included. */
  sims: ReadonlyMap<string, AgentSim>;
  /** `chat.delete`: ends `sim` for good (its pane closes, its card and what hostd keeps for it go) and lists it in `HostInfo.pruned`. */
  forget(sim: AgentSim): void;
}

/** A seeded chat agent: its folder and its conversation so far. */
export interface SeededChat {
  def: AgentDef;
  folder: string;
  steps: Step[];
}

/**
 * What a new chat's herdr name is made from when the launch spec names none, as tf-hostd makes it
 * (`chats::chat_name`): the prompt's first words joined with `-` within 28 characters (the first word always),
 * else `chat` (no prompt, or nothing of it that a herdr name keeps).
 */
export function chatSeed(prompt: string | undefined): string {
  let seed = "";
  for (const word of (prompt ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (seed && seed.length + 1 + word.length > 28) break;
    seed = seed ? `${seed}-${word}` : word;
  }
  return /[A-Za-z0-9]/.test(seed) ? seed : "chat";
}

/** A chat folder's tab label: the folder's name without its id (`lisbon-k3x9q2` → `lisbon`). */
export function chatLabel(folder: string): string {
  const base = folder.split("/").pop() || "chat";
  return base.replace(/-[a-z0-9]{6}$/, "") || base;
}

/** How a daemon before chats answers `agent.start` with the chat target: the target doesn't parse. */
export function chatTargetRefused(): Error {
  return apiError("invalid_params", "agent.start: unknown variant `chat`, expected one of `workspace`, `pane`, `cwd`");
}

// ------------------------------------------------------------------ replies

/** Prompts that want something current or from elsewhere: the chat searches the web before it answers. */
const LOOK_UP = /\b(latest|news|today|tonight|current|currently|recent|price|prices|cost|costs|weather|compare|versus|vs|search|look up|find|recommend|best|trip|travel|visit|open|hours|reviews?)\b/i;
const QUESTION = /\?$|^(what|why|how|when|where|who|which|is|are|can|could|should|do|does|did|will|would)\b/i;

function sourcesFor(query: string): WebSource[] {
  const q = encodeURIComponent(query.slice(0, 120));
  if (/\b(trip|travel|visit|flight|flights|hotel|weekend|city|beach|museum|itinerary)\b/i.test(query)) {
    return [
      { title: "Wikivoyage", url: `https://en.wikivoyage.org/w/index.php?search=${q}`, snippet: "Free travel guide: getting there, getting around, what to see, where to eat and sleep." },
      { title: "Lonely Planet", url: "https://www.lonelyplanet.com/", snippet: "When to go, things to do and where to stay, kept up to date by local writers." },
      { title: "Rome2Rio", url: "https://www.rome2rio.com/", snippet: "Every way to get from A to B: trains, buses, flights and ferries, with times and prices." },
    ];
  }
  if (/\b(code|regex|python|javascript|typescript|rust|sql|linux|bash|git|error|api|css|html)\b/i.test(query)) {
    return [
      { title: "MDN Web Docs", url: `https://developer.mozilla.org/en-US/search?q=${q}`, snippet: "Reference and guides for the web platform, with examples." },
      { title: "Stack Overflow", url: `https://stackoverflow.com/search?q=${q}`, snippet: "Answered questions about the same problem, the accepted fix first." },
    ];
  }
  return [
    { title: "Wikipedia", url: `https://en.wikipedia.org/w/index.php?search=${q}`, snippet: "Overview and background, with references." },
    { title: "Reuters", url: `https://www.reuters.com/site-search/?query=${q}`, snippet: "Recent reporting on the topic." },
  ];
}

/**
 * A chat's reply to a prompt (`Agent.chat`): conversational, with at most a light tool first (a fetch of a
 * link in the prompt, a web search for something current); never an edit, a test or a commit.
 */
export function chatTurn(text: string, rng: Rng): Step[] {
  const ask = text.replace(/\s+/g, " ").trim();
  const topic = ask.length > 72 ? `${ask.slice(0, 72).trimEnd()}…` : ask;
  const url = ask.match(/https?:\/\/[^\s<>"')]+/)?.[0];
  if (url) {
    const site = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0] || url;
    return [
      { t: "tool", spec: { tool: "fetch", title: url, args: { url }, ms: 1600, view: { type: "web", query: url, sources: [{ title: site, url, snippet: "Fetched the page and read it as text." }] } } },
      think("Read the page. Now the few points that matter for what they asked.", 1400 + rng.int(0, 1000)),
      say(
        `I read **${site}**. The gist:\n\n- It opens with a short summary; the sections below mostly back it up.\n- The useful part is in the middle: concrete numbers and a worked example.\n- The end is the author's opinion, so weigh it accordingly.\n\nWant a shorter summary, or a closer look at one part?`,
      ),
    ];
  }
  if (LOOK_UP.test(ask)) {
    const sources = sourcesFor(ask);
    const [first, second] = sources as [WebSource, WebSource];
    return [
      think("This needs current information: a quick search first, then a short summary and what to double-check.", 1400 + rng.int(0, 1000)),
      { t: "tool", spec: { tool: "web_search", title: topic, args: { query: ask }, ms: 3200, view: { type: "web", query: topic, answer: `What the top results agree on about ${topic}, and where they differ.`, sources } } },
      say(
        `Here's what the sources above say:\n\n- **${first.title}** has the basics and the up-to-date details.\n- **${second.title}** adds the practical side: what people actually do, and what to avoid.\n- Times, prices and availability change, so check them again close to the day.\n\nWant me to narrow it down, or turn it into a short list?`,
      ),
    ];
  }
  if (QUESTION.test(ask)) {
    return [
      think("A question with no single right answer: give the two common answers and ask what matters to them.", 1400 + rng.int(0, 1000)),
      say(
        "Short answer: it depends mostly on what you want to optimise for.\n\n- **If you want it simple and soon**, take the option that works today and revisit it later.\n- **If it has to last**, spend a little more time up front on the option that is easiest to change.\n\nTell me a bit more about your situation and I'll give you a straight recommendation.",
      ),
    ];
  }
  return [
    think(`A first pass at "${topic}": the essentials, then the extras, then what is still open.`, 1400 + rng.int(0, 1000)),
    say(
      `Here's a first pass at "${topic}":\n\n1. **The essentials**: what has to be true for this to work at all.\n2. **The nice-to-haves**, in the order they add the most.\n3. **The open questions** worth settling before you commit.\n\n${rng.pick(["Want me to expand one of these, or turn the whole thing into a checklist?", "Should I go deeper on one of these, or make it shorter?"])}`,
    ),
  ];
}

// ------------------------------------------------------------------ seeds

const ITINERARY = `# Lisbon, early December: three slow days

Sunset is around 17:15, so the views come early; a rainy day fits the museums.

## Day 1 · Alfama and Baixa
- Morning: Castelo de São Jorge, then wander down through Alfama.
- Lunch: grilled fish at a tasca near Largo do Chafariz de Dentro.
- Late afternoon: Miradouro de Santa Luzia, then the Christmas lights on Rua Augusta.

## Day 2 · Sintra
- Train from Rossio (about 40 min). Book a timed slot for Pena Palace.
- Quinta da Regaleira in the afternoon, when it is quieter.
- Travesseiros at Piriquita before the train back.

## Day 3 · Belém and LX Factory
- Pastéis de Belém early, before the queue; Jerónimos Monastery (closed on Mondays).
- LX Factory in the afternoon; dinner in Campo de Ourique.

## If it rains
- The Gulbenkian Museum, or the National Azulejo Museum.
`;

const DINNER_PLAN = `# Plan: two weeks of weeknight dinners

1. Ten recipes, 30 minutes or less, no oven on weekdays.
2. One shopping list per week, grouped by aisle.
3. Leftovers planned in: Monday's chili fills Wednesday's burritos.
`;

const RECIPES = `# Weeknight recipes

- Chili with black beans (25 min); the leftovers fill Wednesday's burritos.
- Lemon pasta with peas and parmesan (15 min).
- Chickpea curry with coconut milk and spinach (30 min).
- Pan-fried gnocchi with cherry tomatoes (15 min).
- Egg fried rice with whatever is left (10 min).
`;

const PARTY_PLAN = `# Plan: Mia's 8th birthday party

1. Saturday 15:00 to 17:30 at home, ten kids.
2. A treasure hunt in the garden, then pizza and the cake.
3. Ask two parents to stay and help.
`;

/** forge's chat in Review: it planned a trip and wrote the itinerary into its folder. */
const LISBON: AgentDef = {
  id: "lisbon", kind: "omp", workspace: "", column: "review", model: "opus-5", thinking: "medium", since: 540, age: 1_500, ctxPct: 6, cost: 0.31,
  title: "Three relaxed days in Lisbon", line: "Saved as itinerary.md in this chat's folder", files: [],
};

/** forge's chat in Done: a quick answer, marked done (parking parks it at seed); nothing in its folder. */
const POSTCODES: AgentDef = {
  id: "postcodes", kind: "omp", workspace: "", column: "done", model: "sonnet-5", thinking: "low", since: 10_800, age: 11_400, ctxPct: 2, cost: 0.04,
  title: "Regex for UK postcodes", line: "One regex, space optional; normalise to SW1A 1AA", files: [],
};

const POSTCODES_STEPS: Step[] = [
  { t: "user", text: "What's a regex that matches UK postcodes? People type them with and without the space." },
  think("Outward code: one or two area letters, a district digit, maybe a digit or letter after it; inward code: a digit and two letters. The space is optional on input.", 2000),
  say(
    "This accepts every format in use, with the space optional:\n\n```regex\n^([A-Z]{1,2}\\d[A-Z\\d]?) ?(\\d[A-Z]{2})$\n```\n\nMatch it case-insensitively, then normalise: upper-case it and put one space before the last three characters (`sw1a1aa` → `SW1A 1AA`). It also accepts some codes that don't exist; to know a postcode is real you need a lookup, such as the free postcodes.io API.",
  ),
];

const LISBON_STEPS: Step[] = [
  { t: "user", text: "Plan three relaxed days in Lisbon in early December: good food, a few views, one day trip. We don't like rushing." },
  think("Early December: short days, some rain, few crowds. Three slow days with indoor fallbacks; Sintra is the obvious day trip, so check what is open and whether its palaces need booking.", 2400),
  {
    t: "tool",
    spec: {
      tool: "web_search",
      title: "Lisbon in December, Sintra day trip, opening hours",
      args: { query: "Lisbon early December Sintra day trip opening hours booking" },
      ms: 3400,
      view: {
        type: "web",
        query: "Lisbon early December Sintra day trip opening hours booking",
        answer: "Sintra's palaces stay open in winter with shorter hours; Pena Palace sells timed tickets. Trains leave Rossio every 20–30 minutes.",
        sources: [
          { title: "Visit Lisboa", url: "https://www.visitlisboa.com/en", snippet: "Christmas lights, markets and opening hours across the city in December." },
          { title: "Parques de Sintra: Pena Palace", url: "https://www.parquesdesintra.pt/en/", snippet: "Timed-entry tickets; winter hours 09:30 to 18:00, last entry an hour before." },
          { title: "Wikivoyage: Lisbon", url: "https://en.wikivoyage.org/wiki/Lisbon", snippet: "Neighbourhoods, getting around with the Viva Viagem card, day trips." },
        ],
      },
    },
  },
  say(
    "Here's a slow three-day plan for early December (sunset is around 17:15, so the views come early):\n\n**Day 1 · Alfama and Baixa**: Castelo de São Jorge in the morning, then down through Alfama; grilled fish for lunch near Largo do Chafariz de Dentro; Miradouro de Santa Luzia late afternoon and the Christmas lights on Rua Augusta.\n\n**Day 2 · Sintra**: the train from Rossio takes about 40 minutes. Book a timed slot for Pena Palace; Quinta da Regaleira is quieter in the afternoon. Travesseiros at Piriquita before the train back.\n\n**Day 3 · Belém and LX Factory**: Pastéis de Belém early, before the queue, and Jerónimos Monastery (closed on Mondays); LX Factory in the afternoon, dinner in Campo de Ourique.\n\nIf it rains: the Gulbenkian or the National Azulejo Museum. Want me to save this somewhere?",
  ),
  { t: "user", text: "Perfect. Save it as a file I can keep." },
  { t: "tool", spec: { tool: "write", title: "itinerary.md", args: { path: "itinerary.md" }, ms: 600, view: { type: "markdown", text: ITINERARY } } },
  say("Saved as `itinerary.md` in this chat's folder. It stays there even if you delete this chat."),
];

// ------------------------------------------------------------------ folders

/** What keeps a chat folder: its top-level entries besides omp's `.omp/`, sorted (the first 20), and how many. */
function keptIn(d: ChatDir): { kept: string[]; keptCount: number } {
  const names = [...new Set(d.files.map((f) => f.path.split("/")[0] as string))].filter((n) => n !== ".omp").sort();
  return { kept: names.slice(0, 20), keptCount: names.length };
}

/** The chat folders of a demo host whose daemon starts chats, and its `chat.*` methods. */
export class DemoChats {
  private readonly dirs = new Map<string, ChatDir>();
  /** Deleted chats' sessions, newest first: their omp session files stay (Past sessions, search). */
  private gone: PastSession[] = [];
  private readonly rng: Rng;

  constructor(
    private readonly host: ChatsHost,
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }

  /**
   * forge: `lisbon` in Review (its folder keeps the itinerary it wrote), `postcodes` in Done (parking parks it; its
   * folder is empty), and two older folders whose cards are gone (omp deleted their sessions): one keeps the recipes
   * its chat wrote, the other holds only omp's plan.
   */
  seed(): SeededChat[] {
    const now = this.host.now();
    const dir = (name: string, at: number, files: ChatFile[]): string => {
      const folder = `${CHATS}/${name}`;
      this.dirs.set(folder, { folder, at, files });
      return folder;
    };
    const lisbon = dir("lisbon-k3x9q2", now - LISBON.age * 1000, [{ path: "itinerary.md", at: now - (LISBON.since + 20) * 1000, text: ITINERARY }]);
    const postcodes = dir("postcodes-4hz8wq", now - POSTCODES.age * 1000, []);
    dir("dinner-ideas-8f2k1p", now - 41 * DAY, [
      { path: ".omp/plans/2026-09-21-weeknight-dinners.md", at: now - 41 * DAY + 600_000, text: DINNER_PLAN },
      { path: "recipes.md", at: now - 40 * DAY, text: RECIPES },
    ]);
    dir("birthday-party-q2w9n4", now - 33 * DAY, [{ path: ".omp/plans/2026-09-29-birthday-party.md", at: now - 33 * DAY + 900_000, text: PARTY_PLAN }]);
    return [
      { def: LISBON, folder: lisbon, steps: LISBON_STEPS },
      { def: POSTCODES, folder: postcodes, steps: POSTCODES_STEPS },
    ];
  }

  /** A new empty folder for the chat `name`: `<chats>/<name>-<6 random [a-z0-9]>`. */
  create(name: string): string {
    let folder: string;
    do {
      let id = "";
      for (let i = 0; i < 6; i++) id += ALNUM[this.rng.int(0, ALNUM.length - 1)];
      folder = `${CHATS}/${name}-${id}`;
    } while (this.dirs.has(folder));
    this.dirs.set(folder, { folder, at: this.host.now(), files: [] });
    return folder;
  }

  /** `path` is a chat folder: one directly in the chats root, whether or not it is there now. */
  isFolder(path: string): boolean {
    return path.slice(0, path.lastIndexOf("/")) === CHATS;
  }

  /** A chat starts again or resumes at `folder` (tf-hostd's `ensure_folder`): one that went is made again, empty. */
  ensure(folder: string): void {
    if (!this.dirs.has(folder)) this.dirs.set(folder, { folder, at: this.host.now(), files: [] });
  }

  /** The chats root, its folders and their files, for the host's file tree (`fs.*`). */
  paths(): { path: string; dir: boolean }[] {
    const out = [{ path: CHATS, dir: true }];
    for (const d of this.dirs.values()) {
      out.push({ path: d.folder, dir: true });
      for (const f of d.files) out.push({ path: `${d.folder}/${f.path}`, dir: false });
    }
    return out;
  }

  /** The text of a file in a chat folder (`fs.read`), when `path` is one. */
  read(path: string): string | undefined {
    for (const d of this.dirs.values()) {
      if (!path.startsWith(`${d.folder}/`)) continue;
      return d.files.find((f) => `${d.folder}/${f.path}` === path)?.text;
    }
    return undefined;
  }

  /** Deleted chats' sessions (`host.sessions`). */
  sessions(): PastSession[] {
    return this.gone.map((s) => ({ ...s }));
  }

  call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "chat.list":
        return this.list();
      case "chat.delete":
        return this.delete(p);
      default:
        throw apiError("unknown_method", `unknown method \`${method}\``);
    }
  }

  private list(): ChatFolders {
    const chats = [...this.dirs.values()].map((d) => this.view(d)).sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    return { dir: CHATS, chats };
  }

  private view(d: ChatDir): ChatFolder {
    const sim = this.agentIn(d.folder);
    return {
      folder: d.folder,
      ...(sim ? { agentId: sim.agent.id } : {}),
      title: sim?.agent.title || (d.folder.split("/").pop() ?? d.folder),
      ...keptIn(d),
      bytes: d.files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0),
      modifiedAt: Math.max(d.at, ...d.files.map((f) => f.at)),
    };
  }

  /** The agent on the board that uses `folder` (its cwd is it or in it), as tf-hostd picks it: a live one first, else a parked or ended card. */
  private agentIn(folder: string): AgentSim | undefined {
    let card: AgentSim | undefined;
    for (const s of this.host.sims.values()) {
      const cwd = s.agent.cwd ?? "";
      if (!s.agent.chat || (cwd !== folder && !cwd.startsWith(`${folder}/`))) continue;
      if (!s.agent.parked) return s;
      card ??= s;
    }
    return card;
  }

  /**
   * As tf-hostd: one chat by its agent (live, parked or ended), or by its folder (a folder directly in the chats
   * root; the agent using it, if any, goes too). A dry run changes nothing. Otherwise the agent ends and is
   * forgotten, and the folder goes unless something in it is kept or another card (live, parked or ended) works
   * in it (`sharedWith`).
   */
  private delete(p: Record<string, unknown>): ChatDeletion {
    const dryRun = p.dryRun === true;
    const asked = typeof p.folder === "string" && p.folder.trim() ? p.folder.trim().replace(/^~(?=\/)/, HOME).replace(/\/+$/, "") : undefined;
    let folder: string;
    let sim: AgentSim | undefined;
    if (p.agentId != null) {
      sim = typeof p.agentId === "string" ? this.host.sims.get(p.agentId) : undefined;
      if (!sim) throw apiError("not_found", `no agent \`${String(p.agentId)}\``);
      if (!sim.agent.chat) throw apiError("invalid_params", `${sim.agent.name} is not a chat`);
      folder = sim.agent.cwd ?? "";
      if (asked !== undefined && asked !== folder) throw apiError("invalid_params", `${sim.agent.name} is a chat in ${folder}, not in the folder given`);
    } else {
      if (asked === undefined) throw apiError("invalid_params", "agentId or folder is required");
      if (!this.isFolder(asked)) throw apiError("invalid_params", `${asked} is not a chat folder (one directly in ${CHATS})`);
      folder = asked;
      sim = this.agentIn(folder);
    }
    // A live agent in a turn: working, or asking something.
    const working = sim !== undefined && !sim.agent.parked && (sim.agent.state === "working" || sim.agent.state === "blocked");
    if (!dryRun && sim) {
      const a = sim.agent;
      this.gone = [{ file: a.omp?.sessionFile ?? "", id: a.omp?.sessionId ?? a.id, title: a.title, cwd: a.cwd, updatedAt: a.live.lastEventAt ?? this.host.now(), messages: sim.items.length, live: false }, ...this.gone];
      this.host.forget(sim);
    }
    // Another card in it keeps the folder, whatever it holds; a folder that is gone already holds nothing and stays gone.
    const other = [...this.host.sims.values()].find((s) => s !== sim && s.agent.chat && (s.agent.cwd === folder || (s.agent.cwd ?? "").startsWith(`${folder}/`)));
    const d = this.dirs.get(folder);
    const kept = d ? keptIn(d) : { kept: [], keptCount: 0 };
    const removed = !dryRun && d !== undefined && kept.keptCount === 0 && other === undefined;
    if (removed) this.dirs.delete(folder);
    return { folder, ...kept, removed, working, ...(other ? { sharedWith: other.agent.title || other.agent.name } : {}) };
  }
}
