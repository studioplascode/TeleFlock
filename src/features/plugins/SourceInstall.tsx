import { Download, RotateCw } from "lucide-react";
import { useState } from "react";
import type { ApiError, InstallScope, PluginList } from "@/core/gen";
import { Button, Input, Select } from "@/design";
import { errorLine, firstAdded, rowKeys, type SpecKind, specError, specKind } from "./model";
import type { PluginsQuery } from "./usePlugins";

const KIND_LABEL: Record<SpecKind, string> = { marketplace: "Marketplace plugin", npm: "npm package", git: "Git repository", folder: "Folder on the host" };

const KIND_NOTE: Record<SpecKind, string> = {
  marketplace: "Installs from a marketplace this host knows.",
  npm: "Installs into omp's plugin folder for every project; its code loads when a session starts.",
  git: "Clones and installs it into omp's plugin folder for every project.",
  folder: "Links the folder in: edits there load when a session starts.",
};

/** `plugins.install` of anything omp can install: an npm package, a git source, a folder on the host or `name@marketplace`. */
export function SourceInstall({ cwd, projectName, list, q, onInstalled }: { cwd?: string; projectName?: string; list?: PluginList; q: PluginsQuery; onInstalled(key: string): void }) {
  const [spec, setSpec] = useState("");
  const [scope, setScope] = useState<InstallScope>("user");
  const [error, setError] = useState<ApiError | null>(null);
  const busy = q.busy["install:source"];
  const kind = specKind(spec, list?.marketplaces.map((m) => m.name));
  const shapeError = specError(spec);
  const alreadyThere = !!error && /already installed/i.test(error.message);

  const install = (force: boolean) => {
    const s = spec.trim();
    if (!s || shapeError) return;
    setError(null);
    const before = rowKeys(undefined, list);
    const projectScope = kind === "marketplace" && cwd && scope === "project";
    q.pluginChange((h) => h.call("plugins.install", { spec: s, ...(projectScope ? { scope: "project" as const } : {}), ...(force ? { force } : {}), ...(cwd ? { cwd } : {}) }), {
      busy: [{ key: "install:source", label: force ? "Reinstalling…" : "Installing…" }],
      title: `${force ? "Reinstalled" : "Installed"} ${s}`,
      failTitle: `Couldn't install ${s}`,
      change: force ? "change" : "add",
      lines: true,
      inline: (e) => e.code === "invalid_params" || e.code === "omp_error" || e.code === "not_found",
      action: (changed) => {
        const added = firstAdded(before, rowKeys(undefined, changed.list as PluginList));
        return added ? { label: "Show", onClick: () => onInstalled(added) } : undefined;
      },
    }).then(
      (changed) => changed && setSpec(""),
      (e: ApiError) => setError(e),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="px-0.5 text-xs text-mute">
        An npm package (<code className="font-mono text-ink-2">my-plugin</code>, <code className="font-mono text-ink-2">@scope/pkg@1.2</code>), a git repository (
        <code className="font-mono text-ink-2">github:user/repo</code>, an https URL with <code className="font-mono text-ink-2">#ref</code>), a folder on the host, or{" "}
        <code className="font-mono text-ink-2">name@marketplace</code>.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          install(false);
        }}
      >
        <Input
          value={spec}
          onChange={(e) => {
            setSpec(e.target.value);
            setError(null);
          }}
          placeholder="Package, git URL, folder or name@marketplace"
          aria-label="What to install"
          invalid={!!error || !!shapeError}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          boxClassName="min-w-0 flex-[1_1_18rem]"
          trailing={kind ? <span className="pr-1 text-2xs font-semibold whitespace-nowrap text-mute-2">{KIND_LABEL[kind]}</span> : undefined}
        />
        {kind === "marketplace" && cwd && (
          <Select
            aria-label="For"
            value={scope}
            onValueChange={(v) => setScope(v as InstallScope)}
            options={[
              { value: "user", label: "Every project" },
              { value: "project", label: `${projectName ?? "This project"} only` },
            ]}
            className="h-10 w-44 max-md:flex-1"
          />
        )}
        <Button type="submit" variant="primary" icon={<Download />} loading={!!busy} disabled={!spec.trim() || !!shapeError || !!busy}>
          {busy ?? "Install"}
        </Button>
      </form>
      {(shapeError || error) && (
        <div className="flex flex-wrap items-center gap-2 px-0.5">
          <p className="min-w-0 flex-1 text-xs break-words text-error">{shapeError ?? (error && errorLine(error))}</p>
          {alreadyThere && (
            <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => install(true)}>
              Reinstall
            </Button>
          )}
        </div>
      )}
      {kind && !error && !shapeError && <p className="px-0.5 text-2xs text-mute-2">{KIND_NOTE[kind]}</p>}
    </div>
  );
}
