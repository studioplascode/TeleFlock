import { describe, expect, test } from "bun:test";
import type { ArtifactContent, LocalWritten, OmpSettingValues, SessionArtifacts } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig(host: string) {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(8000);
  return async <T>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost(host, method, params);
    clock.advance(400);
    return (await p) as T;
  };
}

describe("demo host: pasted texts", () => {
  test("session.writeLocal numbers paste-N.md per session; the files list and read back", async () => {
    const call = rig("forge");
    const first = await call<LocalWritten>("session.writeLocal", { agentId: "kanban", text: "one\n".repeat(120) });
    const second = await call<LocalWritten>("session.writeLocal", { agentId: "kanban", text: "two" });
    expect([first.name, first.url, second.name]).toEqual(["paste-1.md", "local://paste-1.md", "paste-2.md"]);
    expect(first.path.endsWith("/local/paste-1.md")).toBe(true);
    const list = await call<SessionArtifacts>("session.artifacts", { agentId: "kanban" });
    const urls = list.files.map((f) => f.url);
    expect(urls.includes("local://paste-1.md") && urls.includes("local://paste-2.md")).toBe(true);
    const read = await call<ArtifactContent>("session.artifact", { agentId: "kanban", kind: "local", name: "paste-2.md" });
    expect(read.text).toBe("two");
    await expect(call("session.writeLocal", { agentId: "kanban", text: "" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  test("omp.settingValues answers the paste menu threshold", async () => {
    const call = rig("forge");
    const r = await call<OmpSettingValues>("omp.settingValues", { keys: ["paste.largeMenuThreshold", "no.such.key"] });
    expect(r.values).toEqual({ "paste.largeMenuThreshold": 100 });
  });
});
