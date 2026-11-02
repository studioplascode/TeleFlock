import { afterEach, describe, expect, test } from "bun:test";
import { core } from "@/core";
import type { RefusalFallbackSetParams, RefusalRule } from "@/core/gen";
import { useToastStore } from "@/design";
import { alwaysDoThis, removeRule } from "./actions";
import { changeRules, type HostRules, loadRules } from "./store";

const realHost = core.host;
afterEach(() => {
  core.host = realHost;
  useToastStore.setState({ toasts: [] });
});

const rule = (to: string): RefusalRule => ({ category: "cyber", from: "anthropic/claude-opus-5-5", to, after: "stay" });
const [SONNET, GPT] = [rule("anthropic/claude-sonnet-5-5"), rule("openai/gpt-5.5")];

/**
 * A tf-hostd that keeps its rules and acts on each call as it arrives. Its answers come on the next turn of the
 * event loop, or, once `hold()`, when `release(method, nth)` lets the nth held call of that method answer.
 */
function fakeHost(rules: RefusalRule[] = []) {
  const held: { method: string; send: () => void }[] = [];
  let holding = false;
  core.host = () =>
    ({
      call: (method: string, params: unknown) => {
        let answer: unknown = { started: true };
        if (method === "host.refusalFallbackSet") rules = [...(params as RefusalFallbackSetParams).rules];
        if (method.startsWith("host.refusalFallback")) answer = { rules: [...rules] };
        // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
        return new Promise((resolve) => {
          const send = () => resolve(answer);
          if (holding) held.push({ method, send });
          else setTimeout(send, 0);
        });
      },
    }) as never;
  return {
    rules: () => rules,
    hold: () => void (holding = true),
    release(method: string, nth = 0) {
      const i = held.map((h, at) => (h.method === method ? at : -1)).filter((at) => at >= 0)[nth];
      if (i !== undefined) held.splice(i, 1)[0]?.send();
    },
  };
}

/** Lets pending promise callbacks run (one turn of the event loop). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("rule changes, one at a time per host", () => {
  test("Always do this on two agents' refusals of one host keeps both rules", async () => {
    const host = fakeHost();
    const [one, two] = await Promise.all([
      alwaysDoThis({ hostId: "h1", agentId: "a", key: "h1::a" }, SONNET, []),
      alwaysDoThis({ hostId: "h1", agentId: "b", key: "h1::b" }, GPT, []),
    ]);
    expect([one, two]).toEqual([true, true]);
    expect(host.rules()).toEqual([GPT, SONNET]);
    // each Undo takes out its own rule only
    expect(await removeRule("h1", SONNET)).toBe(true);
    expect(host.rules()).toEqual([GPT]);
  });

  test("an answer to a question asked before a save is neither shown over it nor used by the next change", async () => {
    const host = fakeHost();
    host.hold();
    let view: Promise<HostRules> | undefined;
    // a view asks just as the change has read the rules and sends its save
    const first = changeRules("h2", (now) => {
      view = loadRules("h2");
      return [...now, SONNET];
    });
    await tick();
    host.release("host.refusalFallback"); // the change's own question: no rules yet
    await tick();
    host.release("host.refusalFallbackSet"); // its save answers before the view's question
    await first;
    const second = changeRules("h2", (now) => [...now, GPT]);
    await tick();
    host.release("host.refusalFallback", 1); // a question of its own, asked after the save
    await tick();
    host.release("host.refusalFallbackSet");
    await second;
    expect(host.rules()).toEqual([SONNET, GPT]);
    host.release("host.refusalFallback"); // the view's answer, from before the first save
    expect((await view)?.rules).toEqual([SONNET, GPT]);
    expect((await loadRules("h2", 60_000)).rules).toEqual([SONNET, GPT]);
  });
});
