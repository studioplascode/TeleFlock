import { FolderGit2, Package, Store } from "lucide-react";
import { SegmentedControl, type SegmentOption, useIsMobile } from "@/design";
import { Catalog } from "./Catalog";
import { SkillSearch } from "./SkillSearch";
import { SourceInstall } from "./SourceInstall";
import type { PluginsQuery } from "./usePlugins";

export type MoreTab = "marketplaces" | "registry" | "source";

/**
 * "Get more": marketplace catalogs (and the marketplaces themselves), the Skillshare registry, and
 * anything else omp installs (npm, git, a folder). `onShow` opens a just-installed row (a toast's "Show").
 */
export function GetMore({
  hostId,
  cwd,
  projectName,
  q,
  tab,
  onTab,
  onShow,
}: {
  hostId: string;
  cwd?: string;
  projectName?: string;
  q: PluginsQuery;
  tab: MoreTab;
  onTab(tab: MoreTab): void;
  onShow(section: "skills" | "plugins", key: string): void;
}) {
  const mobile = useIsMobile();
  const tabs: SegmentOption<MoreTab>[] = [
    { value: "marketplaces", label: "Marketplaces", icon: mobile ? undefined : <Store /> },
    { value: "registry", label: mobile ? "Registry" : "Skill registry", icon: mobile ? undefined : <Package /> },
    { value: "source", label: mobile ? "Other" : "npm · git · folder", icon: mobile ? undefined : <FolderGit2 /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl aria-label="Where from" value={tab} onValueChange={onTab} options={tabs} fill={mobile} className={mobile ? undefined : "self-start"} />
      {tab === "marketplaces" && <Catalog hostId={hostId} cwd={cwd} projectName={projectName} list={q.plugins} q={q} onInstalled={(key) => onShow("plugins", key)} />}
      {tab === "registry" && <SkillSearch hostId={hostId} cwd={cwd} projectName={projectName} q={q} onInstalled={(key) => onShow("skills", key)} onBrowseMarketplaces={() => onTab("marketplaces")} />}
      {tab === "source" && <SourceInstall cwd={cwd} projectName={projectName} list={q.plugins} q={q} onInstalled={(key) => onShow("plugins", key)} />}
    </div>
  );
}
