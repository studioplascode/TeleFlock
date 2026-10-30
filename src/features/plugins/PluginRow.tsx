import { ArrowUpCircle, ChevronDown, Copy, ExternalLink, Link2, MoreHorizontal, Package, Store, Trash2 } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { linkProps } from "@/core";
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, formatAge, IconButton, Switch, Tile, useCalmMotion, useIsMobile, useNow } from "@/design";
import { copyText } from "@/features/hosts/CopyCommand";
import { tildify } from "@/features/workspace/shared/paths";
import { type AnyPlugin, isMarketplacePlugin, isoMs, pluginKey, pluginUpdate } from "./model";
import { BusyLabel, Fact, Facts, Glyph, ProvidesChips, Tag, UpdateBadge, Version } from "./parts";

export type PluginAction = "upgrade" | "remove";

export interface PluginRowProps {
  plugin: AnyPlugin;
  /** Switch state: the requested one while the change is on its way. */
  enabled: boolean;
  /** The change running on it ("Upgrading…"). */
  busy?: string;
  expanded: boolean;
  /** Bumped to bring the row into view and light it up (just installed). */
  flash?: number;
  home?: string;
  onToggle(key: string): void;
  onAction(action: PluginAction, plugin: AnyPlugin): void;
  onEnabled(plugin: AnyPlugin, enabled: boolean): void;
}

/** "Updated 3d ago", ticking on its own (the row doesn't re-render for it). */
function UpdatedAgo({ at }: { at: number }) {
  const now = useNow(60_000);
  return <span title={new Date(at).toLocaleString()}>{formatAge(now - at)}</span>;
}

/** One plugin: a package (npm, git, a linked folder) or a marketplace install, with its switch, update and ⋯ (Upgrade, Remove). */
export const PluginRow = memo(function PluginRow({ plugin: p, enabled, busy, expanded, flash, home, onToggle, onAction, onEnabled }: PluginRowProps) {
  const mobile = useIsMobile();
  const calm = useCalmMotion();
  const tile = useRef<HTMLDivElement>(null);
  const key = pluginKey(p);
  const market = isMarketplacePlugin(p) ? p : null;
  const pkg = isMarketplacePlugin(p) ? null : p;
  const linked = !!pkg?.linked;
  const update = pluginUpdate(p);
  const name = market ? market.name : p.name;
  const updatedAt = market ? isoMs(market.updatedAt) : undefined;
  const path = market ? market.path : pkg?.path;
  // A linked folder is your own checkout: nothing to upgrade from.
  const canUpgrade = !linked;

  useEffect(() => {
    if (flash) tile.current?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }, [flash, calm]);

  const badges = busy ? <BusyLabel label={busy} /> : update && <UpdateBadge to={update} title={`${update} is in ${market?.marketplace ?? "its marketplace"}'s catalog`} />;
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={`More for ${name}`} size={mobile ? "md" : "sm"} disabled={!!busy}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canUpgrade && (
          <DropdownMenuItem icon={<ArrowUpCircle />} onSelect={() => onAction("upgrade", p)}>
            {update ? `Update to ${update}` : "Upgrade"}
          </DropdownMenuItem>
        )}
        {canUpgrade && <DropdownMenuSeparator />}
        <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => onAction("remove", p)}>
          {linked ? "Unlink" : "Remove"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Tile ref={tile} data-plugin-row={key} variant="flat" className={cn("bg-white/[0.022] px-3.5 py-3 transition-colors hover:bg-white/[0.035] md:px-4", (!enabled || market?.shadowed) && "bg-white/[0.012]")}>
      {flash ? (
        <span
          key={flash}
          aria-hidden
          className="tf-keep pointer-events-none absolute inset-0 animate-[tf-flash_1.6s_ease-out_0.3s_both] rounded-tile bg-accent/[0.05] shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.7),0_0_28px_-6px_rgb(163_92_240/0.5)]"
        />
      ) : null}
      <div className="flex items-center gap-3">
        <button type="button" aria-expanded={expanded} onClick={() => onToggle(key)} className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-ring", market?.shadowed && "opacity-55")}>
          <Glyph dim={!enabled}>{market ? <Store /> : linked ? <Link2 /> : <Package />}</Glyph>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn("min-w-0 truncate text-md font-bold", enabled ? "text-ink" : "text-ink-2")}>{name}</span>
              <Version v={p.version} />
              {market?.scope === "project" && <Tag tone="project">Project</Tag>}
              {linked && (
                <Tag tone="accent" title="A folder linked in: your edits load when a session starts">
                  Linked
                </Tag>
              )}
              {market && <span className="min-w-0 shrink truncate text-2xs font-semibold text-mute-2">{market.marketplace}</span>}
            </span>
            <span className={cn("text-2xs text-mute-2", expanded ? "line-clamp-3" : "truncate")} title={p.description}>
              {p.description || "—"}
            </span>
            {p.provides.length > 0 && <ProvidesChips provides={p.provides} className="mt-1" />}
            {mobile && badges && <span className="mt-1 flex items-center gap-2">{badges}</span>}
          </span>
          {!mobile && badges}
        </button>
        <Switch checked={enabled} disabled={!!busy} onCheckedChange={(v) => onEnabled(p, v)} label={enabled ? `Switch ${name} off` : `Switch ${name} on`} />
        {menu}
        {!mobile && <ChevronDown className={cn("size-4 shrink-0 text-mute-2 transition-transform", expanded && "rotate-180")} aria-hidden onClick={() => onToggle(key)} />}
      </div>
      {market?.shadowed && <p className="mt-1.5 pl-12 text-2xs font-semibold text-mute">This project's own install of {market.name} wins here: sessions in this project use that one.</p>}
      {expanded && (
        <div className="mt-3.5 flex flex-col gap-3 border-t border-line pt-3.5 md:pl-12">
          {pkg && pkg.features.length > 0 && (
            <section aria-label="Optional features" className="flex flex-col gap-1.5">
              <h4 className="kicker">Optional features</h4>
              <ul className="flex flex-col gap-1">
                {pkg.features.map((f) => (
                  <li key={f.name} className="flex min-w-0 items-baseline gap-2 text-xs">
                    <code className={cn("shrink-0 font-mono text-2xs font-semibold", f.enabled ? "text-ink-2" : "text-mute-2")}>{f.name}</code>
                    {!f.enabled && <Tag>Off</Tag>}
                    {f.description && <span className="min-w-0 truncate text-2xs text-mute-2">{f.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Facts>
            {path && (
              <Fact label={linked ? "Folder" : "Installed in"}>
                <span className="inline-flex max-w-full items-center gap-1">
                  <code className="min-w-0 truncate font-mono text-2xs" title={path}>
                    {tildify(path, home)}
                  </code>
                  <IconButton size="sm" label="Copy the path" onClick={() => copyText(path, "Path")}>
                    <Copy />
                  </IconButton>
                </span>
              </Fact>
            )}
            {market && (
              <Fact label="From">
                <code className="font-mono text-2xs">{market.id}</code>
              </Fact>
            )}
            {market && <Fact label="For">{market.scope === "project" ? "This project" : "Every project (user level)"}</Fact>}
            {updatedAt !== undefined && (
              <Fact label="Updated">
                <UpdatedAgo at={updatedAt} />
              </Fact>
            )}
            {!market && <Fact label="Code">{linked ? "Edits in the folder load when a session starts" : "Loads when a session starts: restart sessions after a change"}</Fact>}
            {market?.homepage && linkProps(market.homepage) && (
              <Fact label="Homepage">
                <a {...linkProps(market.homepage)} className="inline-flex items-center gap-1 font-semibold text-accent-hi hover:underline">
                  {market.homepage.replace(/^https?:\/\//, "")}
                  <ExternalLink className="size-3" />
                </a>
              </Fact>
            )}
          </Facts>
        </div>
      )}
    </Tile>
  );
});
