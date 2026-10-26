import type { HostProfile } from "@/core/gen";
import { normalizeGroup } from "@/features/hosts/kinds";
import type { RecentRepo } from "./thread";

/*
 * Dispatch Auto mode: a host group is one target. Its repositories are the union of the group
 * hosts' repositories, matched by their `origin` remote (each host keeps its own checkout root),
 * and every send goes to the least busy online host that has the repository (`@/core/workload`).
 */

/** Target ids: a host id, or `auto:<group>` (host ids never contain `:`). */
export const AUTO_PREFIX = "auto:";

export function autoTarget(group: string): string {
  return `${AUTO_PREFIX}${group}`;
}

/** The group of an `auto:<group>` target, else null (a host id). */
export function groupOf(target: string | null | undefined): string | null {
  return target?.startsWith(AUTO_PREFIX) ? target.slice(AUTO_PREFIX.length) : null;
}

/** Profiles of a group (case-insensitive, as normalised on save), in profile order. */
export function groupHosts(profiles: readonly HostProfile[], group: string): HostProfile[] {
  const g = group.toLowerCase();
  return profiles.filter((p) => normalizeGroup(p.group)?.toLowerCase() === g);
}

/**
 * One identity for every clone of a repository: `host/path` of its remote URL, lowercase, without
 * scheme, user, port, `.git` or trailing slash (`git@github.com:o/r.git`, `https://github.com/O/r`
 * and `ssh://git@github.com:22/o/r` are all `github.com/o/r`). Null for an empty URL.
 */
export function canonicalRemote(url: string | null | undefined): string | null {
  let u = (url ?? "").trim().toLowerCase();
  if (!u) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(u);
  if (scheme) {
    u = u.slice(scheme[0].length);
    // user@host:port/path → host/path
    u = u.replace(/^[^@/]*@/, "").replace(/^([^/:]+):\d+(?=\/)/, "$1");
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/.exec(u);
    if (scp) u = `${scp[1]}/${scp[2]}`;
  }
  u = u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return u || null;
}

/** Repo identity of `root` on `hostId`: its canonical remote, else a host-local id (only that host has it). */
export function repoIdOf(hostId: string, root: string, remotes: Readonly<Record<string, string>>): string {
  return remotes[remoteKey(hostId, root)] ?? `local:${hostId}:${root}`;
}

/** Key of the learned remotes map: host + checkout root. */
export function remoteKey(hostId: string, root: string): string {
  return `${hostId}\u0000${root}`;
}

export interface GroupRepo {
  /** Canonical remote (or a host-local id for repos without one). */
  id: string;
  name: string;
  /** Checkout root per host that has it. */
  roots: Record<string, string>;
  /** Most recent activity on any host. */
  at: number;
}

/** The union of the group hosts' recent repositories, one row per repository identity, most recent first. */
export function groupRepos(hosts: readonly { hostId: string; recents: readonly RecentRepo[] }[], remotes: Readonly<Record<string, string>>): GroupRepo[] {
  const byId = new Map<string, GroupRepo>();
  for (const { hostId, recents } of hosts) {
    for (const r of recents) {
      const id = repoIdOf(hostId, r.root, remotes);
      const cur = byId.get(id);
      if (!cur) byId.set(id, { id, name: r.name, roots: { [hostId]: r.root }, at: r.at });
      else {
        cur.roots[hostId] ??= r.root;
        cur.at = Math.max(cur.at, r.at);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

/** The host-local ids a repository had on each of its hosts before their remote was known. */
export function localRepoIds(repo: GroupRepo): string[] {
  return Object.entries(repo.roots).map(([h, root]) => `local:${h}:${root}`);
}

/**
 * The repository behind a stored repo id (a thread's, a draft's, `lastRepo`): by identity, else by
 * the host-local id it had until a workspace reported its remote (the id moves; threads don't).
 */
export function findGroupRepo(repos: readonly GroupRepo[], id: string): GroupRepo | undefined {
  return repos.find((r) => r.id === id) ?? (id.startsWith("local:") ? repos.find((r) => localRepoIds(r).includes(id)) : undefined);
}
