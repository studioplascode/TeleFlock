import { ChevronLeft, ChevronRight, Copy, Download, PartyPopper, RefreshCw, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHostIds, useHosts } from "@/core";
import { Button, EmptyState, IconButton, PageHeader, Skeleton, Tile, cn, toast, useIsMobile } from "@/design";
import { reportError } from "@/features/board/agentActions";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { buildCard, fileName, mergeReports, weekOf, type Week, type WrappedCard } from "./model";
import { loadPosterFonts, paintPoster, POSTER_H, POSTER_W, posterPng } from "./paint";
import { canCopyImages, canShareFiles, copyPng, inAndroidApp, savePng, sharePng } from "./share";
import { useWrapped } from "./useWrapped";

/** Weeks back the arrows reach. */
const MAX_BACK = 52;

/** How each figure is counted (the feature README says the same). */
const DEFINITIONS: readonly (readonly [string, string])[] = [
  ["Unattended work", "Time agents worked on their own: their requests and the tool runs between them. A pause over 10 minutes or a prompt of yours ends a stretch; agents add up."],
  ["Agents run", "omp sessions that worked in the week, with their subagent runs and the automation runs that started agents."],
  ["Lines changed", "Added and removed lines of your non-merge commits in the week, in the repositories the agents worked in. Lock files and GitHub's merge commits are left out; a commit two hosts have counts once."],
  ["PRs merged", "Your pull requests merged in the week in those repositories, asked with gh on each host."],
  ["Longest overnight streak", "The longest stretch with an agent working (pauses up to 10 minutes) that ran through part of a night, midnight to 6 am."],
  ["Fastest model", "The highest average output speed (omp's tokens per second) among models with at least 5 timed requests."],
  ["Busiest subagent", "The subagent with the most model requests, its steps, in the week."],
];

/** The poster on screen: the same canvas the PNG is made from, painted again only when the card changes. */
function Poster({ card, className }: { card: WrappedCard; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sig = JSON.stringify(card);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const drawn: WrappedCard = JSON.parse(sig);
    paintPoster(ctx, drawn);
    let alive = true;
    void loadPosterFonts().then(() => alive && paintPoster(ctx, drawn));
    return () => {
      alive = false;
    };
  }, [sig]);
  return (
    <canvas
      ref={ref}
      width={POSTER_W}
      height={POSTER_H}
      role="img"
      aria-label={card.summary}
      data-testid="wrapped-poster"
      className={cn("block aspect-[4/5] h-auto w-full rounded-tile shadow-d3", className)}
    />
  );
}

function WeekNav({ week, card, onBack, className }: { week: Week; card: WrappedCard; onBack: (back: number) => void; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton label="Earlier week" variant="secondary" size="sm" disabled={week.back >= MAX_BACK} onClick={() => onBack(week.back + 1)}>
        <ChevronLeft />
      </IconButton>
      <div className="min-w-36 flex-1 px-2 text-center">
        <div className="text-sm font-bold text-ink">{card.period}</div>
        <div className="text-2xs font-semibold text-mute tabular">{card.range}</div>
      </div>
      <IconButton label="Later week" variant="secondary" size="sm" disabled={week.back === 0} onClick={() => onBack(week.back - 1)}>
        <ChevronRight />
      </IconButton>
    </div>
  );
}

function Actions({ card, week, className }: { card: WrappedCard; week: Week; className?: string }) {
  const [busy, setBusy] = useState<"copy" | "save" | "share" | null>(null);
  const [copyable] = useState(canCopyImages);
  const [shareable] = useState(canShareFiles);
  const name = fileName(week);
  const copy = () => {
    setBusy("copy");
    copyPng(posterPng(card))
      .then(
        () => toast({ title: "Image copied", description: "Paste it into any chat or post.", status: "done" }),
        (e: unknown) => reportError("Couldn't copy the image", e instanceof Error ? e.message : e),
      )
      .finally(() => setBusy(null));
  };
  const save = () => {
    setBusy("save");
    posterPng(card)
      .then(
        (png) => {
          savePng(png, name);
          toast({ title: `Saved ${name}`, description: "In your downloads.", status: "done" });
        },
        (e: unknown) => reportError("Couldn't make the image", e instanceof Error ? e.message : e),
      )
      .finally(() => setBusy(null));
  };
  const share = () => {
    setBusy("share");
    posterPng(card)
      .then((png) => sharePng(png, name, `Flock Wrapped · ${card.range}`))
      .catch((e: unknown) => {
        if (!(e instanceof Error && e.name === "AbortError")) reportError("Couldn't share the image", e instanceof Error ? e.message : e);
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className={cn("grid gap-2", className)}>
      {copyable && (
        <Button variant="primary" icon={<Copy />} loading={busy === "copy"} disabled={busy !== null} onClick={copy}>
          Copy image
        </Button>
      )}
      {/* The Android app's WebView has no downloads: its share sheet saves to the device too. */}
      {!inAndroidApp && (
        <Button variant={copyable ? "secondary" : "primary"} icon={<Download />} loading={busy === "save"} disabled={busy !== null} onClick={save}>
          Save PNG
        </Button>
      )}
      {shareable && (
        <Button variant={!copyable && inAndroidApp ? "primary" : "secondary"} icon={<Share2 />} loading={busy === "share"} disabled={busy !== null} onClick={share}>
          Share…
        </Button>
      )}
    </div>
  );
}

function Notes({ notes, className }: { notes: string[]; className?: string }) {
  if (notes.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1.5 text-xs text-mute", className)} aria-label="About these figures">
      {notes.map((n) => (
        <li key={n} className="flex gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn/80" aria-hidden />
          <span className="min-w-0">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function Definitions({ className }: { className?: string }) {
  return (
    <Tile variant="flat" className={cn("p-5 max-md:p-4", className)}>
      <h2 className="kicker">How it's counted</h2>
      <dl className="mt-3 flex flex-col gap-2.5 text-xs">
        {DEFINITIONS.map(([term, def]) => (
          <div key={term}>
            <dt className="font-bold text-ink">{term}</dt>
            <dd className="mt-0.5 text-mute">{def}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

/** Flock Wrapped: the week's digest of every host in view, as a card to share (architecture §3.19). */
export function WrappedView() {
  const filter = useHosts((s) => s.filter);
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const ids = useHostIds();
  const hostIds = filter === "all" ? ids : [filter];
  const [opened] = useState(() => Date.now());
  const [back, setBack] = useState(1);
  const [nonce, setNonce] = useState(0);
  const week = weekOf(opened, back);
  const { answers, loading } = useWrapped(hostIds, week, nonce);
  const mobile = useIsMobile();

  const name = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const answered = answers.flatMap((a) => (a.report ? [{ host: name(a.hostId), report: a.report }] : []));
  const facts = mergeReports(
    answered.map((a) => a.report),
    answered.map((a) => a.host),
  );
  const card = buildCard(facts, week, answered.length);
  const notes = [
    ...hostIds.filter((id) => status[id]?.phase !== "online").map((id) => `${name(id)} is not connected: its week is not on the card.`),
    ...answers.flatMap((a) =>
      !a.error ? [] : a.error.code === "unknown_method" ? [`${name(a.hostId)} runs an older TeleFlock: update it to add its week.`] : [`${name(a.hostId)}: ${a.error.message}`],
    ),
    ...(facts.unindexed > 0 ? [`omp has not indexed ${facts.unindexed === 1 ? "one host" : `${facts.unindexed} hosts`} yet: agents and work appear after its first sync.`] : []),
    ...(facts.indexing ? ["omp is indexing sessions: figures may still grow."] : []),
    ...(facts.pending ? ["Counting commits and pull requests…"] : []),
    ...facts.notes,
  ];
  const refresh = (
    <IconButton label="Count again" variant={mobile ? "ghost" : "secondary"} disabled={loading} onClick={() => setNonce((n) => n + 1)}>
      <RefreshCw />
    </IconButton>
  );
  const poster = loading && answers.length === 0 ? <Skeleton className="aspect-[4/5] w-full rounded-tile" /> : <Poster card={card} />;

  if (hostIds.length === 0) {
    const empty = <EmptyState icon={<PartyPopper />} title="No hosts connected" description="Flock Wrapped adds up the week of every host's agents." className="mt-10" />;
    if (!mobile) return <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pt-7 pb-12">{empty}</div>;
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Flock Wrapped" back />
        {empty}
      </div>
    );
  }

  if (mobile)
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Flock Wrapped" subtitle="Your flock's week" back actions={refresh} />
        <div className="flex flex-col gap-4 px-3 pt-1 pb-6">
          <WeekNav week={week} card={card} onBack={setBack} />
          {poster}
          <Actions card={card} week={week} className="grid-cols-2 [&>*:only-child]:col-span-2 [&>*:nth-child(3)]:col-span-2" />
          <Notes notes={notes} className="px-1" />
          <Definitions />
        </div>
      </div>
    );
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-8 pt-7 pb-12">
      <PageHeader
        kicker="Weekly"
        title="Flock Wrapped"
        description="Your flock's week on one card: unattended work, code shipped and the week's champions. Share it as an image."
        actions={
          <div className="flex items-center gap-2">
            <WeekNav week={week} card={card} onBack={setBack} />
            {refresh}
          </div>
        }
      />
      <div className="grid grid-cols-[minmax(0,540px)_minmax(0,1fr)] items-start gap-8">
        {poster}
        <div className="flex flex-col gap-5">
          <Actions card={card} week={week} className="max-w-72" />
          <Notes notes={notes} />
          <Definitions />
        </div>
      </div>
    </div>
  );
}
