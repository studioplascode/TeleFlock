import { describe, expect, test } from "bun:test";
import { OMP_SETTINGS_FIXTURE } from "@/core/demo/ompSettingsFixture";
import { splitTicks } from "./Ticks";

const code = (text: string) => ({ text, code: true });
const plain = (text: string) => ({ text, code: false });

describe("splitTicks", () => {
  test("backtick pairs become code; the text around them stays", () => {
    expect(splitTicks("Agents, commands and `--model @role` refer to these roles.")).toEqual([plain("Agents, commands and "), code("--model @role"), plain(" refer to these roles.")]);
    expect(splitTicks("`omp --resume`")).toEqual([code("omp --resume")]);
    expect(splitTicks("`a` or `b`")).toEqual([code("a"), plain(" or "), code("b")]);
    expect(splitTicks("no code here")).toEqual([plain("no code here")]);
    expect(splitTicks("")).toEqual([]);
  });

  test("an unpaired backtick or an empty pair stays literal", () => {
    expect(splitTicks("press ` to open")).toEqual([plain("press ` to open")]);
    expect(splitTicks("run `herdr update` then ` again")).toEqual([plain("run "), code("herdr update"), plain(" then ` again")]);
    expect(splitTicks("an empty `` pair, then `x`")).toEqual([plain("an empty `` pair, then "), code("x")]);
  });

  test("omp's own setting descriptions: flags and keys come out as code, nothing is lost", () => {
    const loop = OMP_SETTINGS_FIXTURE.find((s) => s.id === "loop.conditionTimeoutMs")?.description ?? "";
    expect(splitTicks(loop).filter((p) => p.code).map((p) => p.text)).toEqual(["/loop --while", "--until"]);
    for (const s of OMP_SETTINGS_FIXTURE) {
      if (!s.description) continue;
      const parts = splitTicks(s.description);
      const joined = parts.map((p) => (p.code ? `\`${p.text}\`` : p.text)).join("");
      expect(joined).toBe(s.description);
    }
  });
});
