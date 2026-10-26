import { describe, expect, test } from "bun:test";
import type { HostProfile } from "@/core/gen";
import { autoTarget, canonicalRemote, findGroupRepo, groupHosts, groupOf, groupRepos, localRepoIds, remoteKey, repoIdOf } from "./auto";

describe("canonicalRemote", () => {
  test("scp, https, ssh with port, .git, case and trailing slashes are one repository", () => {
    const id = "github.com/acme/teleflock";
    for (const url of [
      "git@github.com:acme/TeleFlock.git",
      "https://github.com/acme/teleflock",
      "https://github.com/Acme/TeleFlock.git/",
      "ssh://git@github.com:22/acme/teleflock.git",
      "ssh://github.com/acme/teleflock",
      "https://user:token@github.com/acme/teleflock.git",
      "git://github.com/acme/teleflock",
      "github.com:acme/teleflock",
    ]) {
      expect({ url, id: canonicalRemote(url) }).toEqual({ url, id });
    }
  });

  test("local paths stay paths; empty is null", () => {
    expect(canonicalRemote("/srv/git/app.git")).toBe("/srv/git/app");
    expect(canonicalRemote("file:///srv/git/app.git")).toBe("/srv/git/app");
    expect(canonicalRemote("")).toBeNull();
    expect(canonicalRemote(undefined)).toBeNull();
  });
});

describe("groups", () => {
  const p = (id: string, group?: string): HostProfile => ({ id, name: id, kind: "demo", herdrSession: "default", autoConnect: true, ...(group ? { group } : {}) });

  test("targets", () => {
    expect(groupOf(autoTarget("Build farm"))).toBe("Build farm");
    expect(groupOf("forge")).toBeNull();
    expect(groupOf(null)).toBeNull();
  });

  test("members match case-insensitively, in profile order", () => {
    expect(groupHosts([p("a", "Farm"), p("b"), p("c", " farm "), p("d", "other")], "FARM").map((x) => x.id)).toEqual(["a", "c"]);
  });

  test("repos are the union over the hosts, matched by remote, each host keeping its root", () => {
    const remotes = { [remoteKey("forge", "/home/me/tf")]: "github.com/acme/tf", [remoteKey("studio", "/work/TeleFlock")]: "github.com/acme/tf" };
    const repos = groupRepos(
      [
        { hostId: "forge", recents: [{ root: "/home/me/tf", name: "tf", at: 5 }, { root: "/home/me/scratch", name: "scratch", at: 9 }] },
        { hostId: "studio", recents: [{ root: "/work/TeleFlock", name: "TeleFlock", at: 7 }] },
      ],
      remotes,
    );
    expect(repos).toEqual([
      { id: "local:forge:/home/me/scratch", name: "scratch", roots: { forge: "/home/me/scratch" }, at: 9 },
      { id: "github.com/acme/tf", name: "tf", roots: { forge: "/home/me/tf", studio: "/work/TeleFlock" }, at: 7 },
    ]);
    expect(repoIdOf("studio", "/work/TeleFlock", remotes)).toBe("github.com/acme/tf");
  });

  test("a thread keyed by a repo's local id still finds it once its remote is known", () => {
    const recents = [{ hostId: "forge", recents: [{ root: "/home/me/tf", name: "tf", at: 5 }] }];
    // Picked (and dispatched to) before any workspace reported the remote.
    const before = groupRepos(recents, {});
    const threadRepo = before[0]?.id ?? "";
    expect(threadRepo).toBe("local:forge:/home/me/tf");
    // The new worktree's workspace reports `origin`: the id moves.
    const after = groupRepos(recents, { [remoteKey("forge", "/home/me/tf")]: "github.com/acme/tf" });
    expect(after.find((r) => r.id === threadRepo)).toBeUndefined();
    const found = findGroupRepo(after, threadRepo);
    expect(found).toMatchObject({ id: "github.com/acme/tf", roots: { forge: "/home/me/tf" } });
    expect(found && localRepoIds(found)).toEqual([threadRepo]);
    expect(findGroupRepo(after, "github.com/acme/tf")?.id).toBe("github.com/acme/tf");
    expect(findGroupRepo(after, "local:studio:/home/me/tf")).toBeUndefined();
  });
});
