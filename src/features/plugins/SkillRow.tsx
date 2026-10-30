import { ArrowUpCircle, Boxes, ChevronDown, Copy, MoreHorizontal, Package, Puzzle, RotateCw, Sparkles, Trash2 } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { SkillInfo } from "@/core/gen";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Switch, Tile, useCalmMotion, useIsMobile } from "@/design";
import { copyText } from "@/features/hosts/CopyCommand";
import { tildify } from "@/features/workspace/shared/paths";
import { latestOutsideRange, registryNeed, type SkillGroupId, type SkillItem, skillGroup, skillSource } from "./model";
import { BusyLabel, Fact, Facts, Glyph, Tag, UpdateBadge, Version } from "./parts";

export type SkillAction = "update" | "restore" | "remove";

export interface SkillRowProps {
  item: SkillItem;
  /** Its skill's switch: the requested state while the change is on its way. */
  enabled: boolean;
  /** The change running on it ("Updating…"). */
  busy?: string;
  expanded: boolean;
  /** Bumped to bring the row into view and light it up (just installed). */
  flash?: number;
  home?: string;
  onToggle(key: string): void;
  onAction(action: SkillAction, item: SkillItem): void;
  onEnabled(skill: SkillInfo, enabled: boolean): void;
}

const GROUP_ICON: Record<SkillGroupId, typeof Package> = { registry: Package, omp: Sparkles, plugins: Puzzle, other: Boxes };
const LEVEL: Record<string, string> = { user: "Every project (user level)", project: "This project", native: "omp's own (built in)" };

/** One skill: what it is, where it comes from, its switch; a registry install also its version, update and ⋯ (Update, Remove). */
export const SkillRow = memo(function SkillRow({ item, enabled, busy, expanded, flash, home, onToggle, onAction, onEnabled }: SkillRowProps) {
  const mobile = useIsMobile();
  const calm = useCalmMotion();
  const tile = useRef<HTMLDivElement>(null);
  const { skill, registry: reg } = item;
  const group: SkillGroupId = reg ? "registry" : skill ? skillGroup(skill) : "other";
  const Icon = GROUP_ICON[group];
  const need = reg ? registryNeed(reg) : null;
  const name = skill?.name ?? reg?.id ?? "";
  const description = skill?.description || reg?.description || "";
  const source = skill ? skillSource(skill) : null;
  const project = reg ? reg.scope === "project" : skill?.level === "project";
  const off = !!skill && !enabled;

  useEffect(() => {
    if (flash) tile.current?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }, [flash, calm]);

  const badges = busy ? (
    <BusyLabel label={busy} />
  ) : (
    reg && (
      <span className="flex shrink-0 items-center gap-2">
        {reg.version && <Version v={reg.version} />}
        {need === "update" && reg.update && <UpdateBadge to={reg.update} title={`${reg.update} is the newest version within ${reg.range ?? "its range"}`} />}
        {reg.yanked && (
          <Tag tone="error" title="The publisher withdrew this version">
            Yanked
          </Tag>
        )}
        {reg.deprecated && (
          <Tag tone="warn" title={reg.deprecated}>
            Deprecated
          </Tag>
        )}
      </span>
    )
  );
  const restore = reg && need === "restore" && !busy && (
    <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => onAction("restore", item)} className="shrink-0">
      Restore
    </Button>
  );
  const menu = reg && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`More for ${reg.id}`} size={mobile ? "md" : "sm"} disabled={!!busy}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {need === "restore" ? (
          <DropdownMenuItem icon={<RotateCw />} onSelect={() => onAction("restore", item)}>
            Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon={<ArrowUpCircle />} onSelect={() => onAction("update", item)}>
            {need === "update" && reg.update ? `Update to ${reg.update}` : "Update"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => onAction("remove", item)}>
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const outside = reg ? latestOutsideRange(reg) : null;

  return (
    <Tile ref={tile} data-skill-row={item.key} variant="flat" className={cn("bg-white/[0.022] px-3.5 py-3 transition-colors hover:bg-white/[0.035] md:px-4", (off || need === "restore") && "bg-white/[0.012]")}>
      {flash ? (
        <span
          key={flash}
          aria-hidden
          className="tf-keep pointer-events-none absolute inset-0 animate-[tf-flash_1.6s_ease-out_0.3s_both] rounded-tile bg-accent/[0.05] shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.7),0_0_28px_-6px_rgb(163_92_240/0.5)]"
        />
      ) : null}
      <div className="flex items-center gap-3">
        <button type="button" aria-expanded={expanded} onClick={() => onToggle(item.key)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-ring">
          <Glyph dim={off || need === "restore"}>
            <Icon />
          </Glyph>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn("min-w-0 truncate text-md font-bold", off ? "text-ink-2" : "text-ink")}>{name}</span>
              {project && <Tag tone="project">Project</Tag>}
              {skill?.hidden && <Tag title="Callable (/skill:name), but left out of the skill list in the system prompt">Hidden</Tag>}
              {source && <span className="min-w-0 shrink truncate text-2xs font-semibold text-mute-2">{source}</span>}
            </span>
            <span className={cn("text-2xs text-mute-2", expanded ? "line-clamp-3" : "truncate")} title={description}>
              {need === "restore" ? "Not in omp's store: sessions skip it until it is restored." : description || "—"}
            </span>
            {mobile && badges && <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2">{badges}</span>}
          </span>
          {!mobile && badges}
        </button>
        {!mobile && restore}
        {skill ? (
          <Switch checked={enabled} disabled={!!busy} onCheckedChange={(v) => onEnabled(skill, v)} label={enabled ? `Switch ${skill.name} off` : `Switch ${skill.name} on`} />
        ) : (
          <span className="w-[34px] shrink-0" aria-hidden />
        )}
        {menu}
        {!mobile && <ChevronDown className={cn("size-4 shrink-0 text-mute-2 transition-transform", expanded && "rotate-180")} aria-hidden onClick={() => onToggle(item.key)} />}
      </div>
      {mobile && restore && <div className="mt-2.5 flex pl-12">{restore}</div>}
      {expanded && (
        <div className="mt-3.5 flex flex-col gap-3 border-t border-line pt-3.5 md:pl-12">
          {reg?.updateError && <p className="text-xs break-words text-warn">The registry couldn't be asked about it: {reg.updateError}</p>}
          {reg?.deprecated && <p className="text-xs break-words text-warn">Deprecated by its publisher: {reg.deprecated}</p>}
          <Facts>
            {skill && (
              <Fact label="File">
                <span className="inline-flex max-w-full items-center gap-1">
                  <code className="min-w-0 truncate font-mono text-2xs" title={skill.path}>
                    {tildify(skill.path, home)}
                  </code>
                  <IconButton size="sm" label="Copy the path" onClick={() => copyText(skill.path, "Path")}>
                    <Copy />
                  </IconButton>
                </span>
              </Fact>
            )}
            {skill && (
              <Fact label="From">
                {skill.providerName || skill.provider}
                {skill.plugin && !reg && ` · ${skill.plugin}`}
              </Fact>
            )}
            {skill && <Fact label="Level">{LEVEL[skill.level] ?? skill.level}</Fact>}
            {reg && (
              <Fact label="Package">
                <code className="font-mono text-2xs">{reg.id}</code>
              </Fact>
            )}
            {reg && (
              <Fact label="Installed">
                {reg.version ?? "not yet"}
                {reg.range && ` (asks for ${reg.range})`}
              </Fact>
            )}
            {reg?.latest && <Fact label="Latest">{outside ? `${reg.latest}: outside ${reg.range ?? "its range"}, so Update stays below it` : reg.latest}</Fact>}
            {reg && <Fact label="Where">{reg.scope === "project" ? "This project's skills.json" : "Your skills.json (every project)"}</Fact>}
          </Facts>
          {reg && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={need === "restore" ? <RotateCw /> : <ArrowUpCircle />} loading={!!busy} disabled={!!busy} onClick={() => onAction(need === "restore" ? "restore" : "update", item)}>
                {need === "restore" ? "Restore" : need === "update" && reg.update ? `Update to ${reg.update}` : "Update"}
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 />} disabled={!!busy} onClick={() => onAction("remove", item)}>
                Remove
              </Button>
            </div>
          )}
        </div>
      )}
    </Tile>
  );
});
