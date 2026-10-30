import { Focus, Grid2x2, Grid3x3, Orbit, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { navigate, onAgentMoved, onAgentsPruned, useCore, useUi } from "@/core";
import { Button, EmptyState, Kbd, SegmentedControl, Switch, Tooltip, useIsMobile, useNow } from "@/design";
import { isTyping } from "@/features/inbox/AnswerParts";
import { usePaletteCommands } from "@/features/palette/registry";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { VIEWS } from "@/features/shell/vocab";
import { gridOf, type WallCandidate, wallCandidates, type WallSize } from "./layout";
import { useWall } from "./store";
import { WallTile } from "./WallTile";

/** Candidates change only when an agent changes lane or state time, not with every streamed token. */
function sameCandidates(a: WallCandidate[], b: WallCandidate[]): boolean {
  return a.length === b.length && a.every((c, i) => c.key === b[i]?.key && c.rank === b[i]?.rank && c.since === b[i]?.since);
}

/**
 * Keeps the store's tiles current: candidates from the core store, a slow tick for tiles whose
 * agent has lingered long enough to make room, and resumed or deleted agents. Renders nothing, so
 * none of this re-renders the tiles unless what they show changes.
 */
function WallSync() {
  const candidates = useCore((s) => wallCandidates(Object.values(s.agents), (hostId) => s.status[hostId]?.phase === "online"), sameCandidates);
  const tick = useNow(30_000);
  useEffect(() => useWall.getState().sync(candidates, Date.now()), [candidates, tick]);
  useEffect(() => onAgentMoved((from, to) => useWall.getState().rename(from, to)), []);
  useEffect(() => onAgentsPruned((gone) => useWall.getState().forget(new Set(gone.flatMap((g) => g.keys)))), []);
  return null;
}

const SIZES = [
  { value: "4", label: "2×2", icon: <Grid2x2 /> },
  { value: "9", label: "3×3", icon: <Grid3x3 /> },
] as const;

function WallToolbar() {
  const size = useWall((s) => s.size);
  const auto = useWall((s) => s.auto);
  const pins = useWall((s) => s.pins.slice(0, s.size).filter(Boolean).length);
  const hidden = useWall((s) => s.hidden.length);
  const focus = useUi((s) => s.focusMode);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <h1 className="mr-2 shrink-0 font-display text-xl font-bold text-ink">{VIEWS.wall.label}</h1>
      <SegmentedControl<string> size="sm" value={String(size)} onValueChange={(v) => useWall.getState().setSize(Number(v) as WallSize)} options={SIZES} aria-label="Grid" className="shrink-0" />
      <Tooltip content="Unpinned tiles show who needs you, then who is running, then what is ready for review">
        <label className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-bold text-ink-2 hover:bg-white/4">
          <Switch checked={auto} onCheckedChange={(on) => useWall.getState().setAuto(on)} label="Fill tiles automatically" />
          Auto-fill
        </label>
      </Tooltip>
      {(pins > 0 || hidden > 0) && (
        <Tooltip content="Unpin every tile and bring removed agents back">
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => useWall.getState().reset()}>
            Reset
          </Button>
        </Tooltip>
      )}
      <span className="ml-auto hidden items-center gap-1.5 text-2xs font-semibold text-mute-2 min-[1500px]:flex">
        Click a tile to reply · drag a header onto another tile to swap · <Kbd>F</Kbd> {focus ? "show the sidebar" : "hide the sidebar"}
      </span>
      <Tooltip content={focus ? "Show the sidebar" : "Hide the sidebar"} shortcut="F">
        <Button size="sm" variant="ghost" icon={<Focus />} onClick={() => useUi.getState().setFocusMode(!useUi.getState().focusMode)} className="shrink-0 min-[1500px]:ml-0 max-[1499px]:ml-auto" aria-pressed={focus}>
          Focus
        </Button>
      </Tooltip>
    </div>
  );
}

function Wall() {
  const size = useWall((s) => s.size);
  const shown = useWall((s) => s.shown);
  const [active, setActive] = useState<number | null>(null);
  const { cols, rows } = gridOf(size);

  // F hides the sidebar (focus mode), Esc brings it back; leaving the wall ends it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [cmdk-root]')) return;
      const ui = useUi.getState();
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        ui.setFocusMode(!ui.focusMode);
      } else if (e.key === "Escape" && ui.focusMode) {
        e.preventDefault();
        ui.setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      useUi.getState().setFocusMode(false);
    };
  }, []);

  const commands = useMemo(
    () => [
      { id: "wall.size4", title: "Wall: 2×2", group: VIEWS.wall.label, keywords: ["grid", "four", "tiles"], icon: <Grid2x2 />, run: () => useWall.getState().setSize(4) },
      { id: "wall.size9", title: "Wall: 3×3", group: VIEWS.wall.label, keywords: ["grid", "nine", "tiles"], icon: <Grid3x3 />, run: () => useWall.getState().setSize(9) },
      { id: "wall.reset", title: "Wall: unpin every tile", group: VIEWS.wall.label, keywords: ["reset", "auto", "clear"], icon: <RotateCcw />, run: () => useWall.getState().reset() },
    ],
    [],
  );
  usePaletteCommands(commands);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3 pt-2.5">
      <WallSync />
      <WallToolbar />
      <div
        className="grid min-h-0 flex-1 gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: size }, (_, i) => (
          <WallTile key={i} index={i} agentKey={shown[i] ?? null} size={size} active={active === i} onActivate={setActive} />
        ))}
      </div>
    </div>
  );
}

/** Phones: a grid of transcripts doesn't fit; ambient mode does. */
function WallNarrow() {
  return (
    <div className="flex min-h-full flex-col">
      <MobileHeader title={VIEWS.wall.label} back />
      <EmptyState
        className="flex-1"
        icon={<Grid2x2 />}
        title="The wall needs a bigger screen"
        description="It shows 4 or 9 live transcripts side by side. On a phone, ambient mode shows every agent as an orb instead."
        action={
          <Button icon={<Orbit />} onClick={() => navigate({ name: "ambient" })}>
            {VIEWS.ambient.label}
          </Button>
        }
      />
    </div>
  );
}

/**
 * Wall (`#/wall`): live transcripts of 4 or 9 agents in a grid for a big monitor. Tiles fill
 * themselves with who needs you, then who runs (pins and drag-to-swap arrange them by hand),
 * questions are answered in the tile and the clicked tile gets a composer.
 */
export function WallView() {
  return useIsMobile() ? <WallNarrow /> : <Wall />;
}
