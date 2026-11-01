import { describe, expect, test } from "bun:test";
import type { ForwardRule } from "@/core/gen";
import { firstFieldError, parseFieldError, ruleErrors, slugify } from "./forward";

const hosts = [
  { id: "dev", name: "dev box" },
  { id: "mac", name: "Studio Mac" },
  { id: "pc", name: "pc" },
];
const rule = (over: Partial<ForwardRule> = {}): ForwardRule => ({ id: "", fromHost: "dev", toHost: "mac", name: "mac", enabled: true, shell: true, tools: [], ports: [], ...over });

describe("slugify", () => {
  test("a host label becomes a rule name", () => {
    expect(slugify("Studio Mac")).toBe("studio-mac");
    expect(slugify("  --Café_PC!! ")).toBe("cafe-pc");
    expect(slugify("★★★")).toBe("host");
    expect(slugify("a".repeat(50))).toHaveLength(32);
    expect(slugify(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
  });

  test("a taken name gets the first free number, still within 32 characters", () => {
    expect(slugify("Mac", ["mac"])).toBe("mac-2");
    expect(slugify("Mac", ["mac", "mac-2"])).toBe("mac-3");
    expect(slugify("m".repeat(40), ["m".repeat(32)])).toBe(`${"m".repeat(30)}-2`);
  });
});

describe("ruleErrors", () => {
  test("a good rule has none", () => {
    expect(ruleErrors(rule({ tools: ["agent-browser"], ports: [{ listen: 9222, target: 9222 }] }), hosts, [])).toEqual({});
  });

  test("hosts must exist and differ", () => {
    expect(ruleErrors(rule({ fromHost: "gone" }), hosts, []).fromHost).toBe("no host gone");
    expect(ruleErrors(rule({ toHost: "dev" }), hosts, []).toHost).toBe("choose a host other than the one the forward is used from");
  });

  test("names: format, then unique per from-host only", () => {
    expect(ruleErrors(rule({ name: "Mac" }), hosts, []).name).toMatch(/^use 1–32 lowercase letters/);
    expect(ruleErrors(rule({ name: "-mac" }), hosts, []).name).toBeDefined();
    const other = rule({ id: "r1", name: "mac" });
    expect(ruleErrors(rule(), hosts, [other]).name).toBe('dev box already has a forward called "mac"');
    expect(ruleErrors(rule({ fromHost: "pc" }), hosts, [other]).name).toBeUndefined();
  });

  test("a rule must forward something", () => {
    expect(ruleErrors(rule({ shell: false }), hosts, []).shell).toBe("turn on the shell, a tool or a port");
    expect(ruleErrors(rule({ shell: false, tools: ["adb"] }), hosts, []).shell).toBeUndefined();
  });

  test("tools: characters, TeleFlock's own command, duplicates, and tools other rules of the from-host forward", () => {
    expect(ruleErrors(rule({ tools: ["ok", "no way"] }), hosts, []).tools).toBe('"no way" is not a command name (letters, digits, . _ + - only, up to 64)');
    expect(ruleErrors(rule({ tools: [".."] }), hosts, []).tools).toBe('".." is not a command name (letters, digits, . _ + - only, up to 64)');
    expect(ruleErrors(rule({ tools: ["tf-forward"] }), hosts, []).tools).toBe(`"tf-forward" is TeleFlock's own command`);
    expect(ruleErrors(rule({ tools: ["a", "a"] }), hosts, []).tools).toBe('"a" is listed twice');
    for (const t of ["con", "NUL", "aux.txt", "Com1", "lpt9.cmd", "prn.", "nul.tar.gz"]) expect(ruleErrors(rule({ tools: [t] }), hosts, []).tools).toBe(`"${t}" is a device name on Windows`);
    for (const t of ["console", "com0", "com10", "lpt", "null", "conda", "x.con"]) expect(ruleErrors(rule({ tools: [t] }), hosts, []).tools).toBeUndefined();
    expect(ruleErrors(rule({ tools: ["x".repeat(65)] }), hosts, []).tools).toBeDefined();
    const other = rule({ id: "r1", name: "pc", toHost: "pc", tools: ["agent-browser"] });
    expect(ruleErrors(rule({ tools: ["agent-browser"] }), hosts, [other]).tools).toBe('dev box already forwards "agent-browser" in forward "pc"');
    expect(ruleErrors(rule({ fromHost: "pc", toHost: "dev", tools: ["agent-browser"] }), hosts, [other]).tools).toBeUndefined();
  });

  test("ports: range, duplicates in the rule, and listen ports other rules of the from-host already hold", () => {
    expect(ruleErrors(rule({ ports: [{ listen: 0, target: 80 }] }), hosts, []).ports).toBe("port numbers are 1–65535");
    expect(ruleErrors(rule({ ports: [{ listen: 80, target: 65536 }] }), hosts, []).ports).toBe("port numbers are 1–65535");
    expect(ruleErrors(rule({ ports: [{ listen: Number.NaN, target: 80 }] }), hosts, []).ports).toBe("port numbers are 1–65535");
    expect(ruleErrors(rule({ ports: [{ listen: 80, target: 1 }, { listen: 80, target: 2 }] }), hosts, []).ports).toBe("80 is listed twice");
    const other = rule({ id: "r1", name: "other", toHost: "pc", ports: [{ listen: 9222, target: 9222 }] });
    expect(ruleErrors(rule({ ports: [{ listen: 9222, target: 1 }] }), hosts, [other]).ports).toBe('dev box already listens on 9222 in forward "other"');
    expect(ruleErrors(rule({ fromHost: "pc", toHost: "dev", ports: [{ listen: 9222, target: 1 }] }), hosts, [other]).ports).toBeUndefined();
  });
});

describe("field errors", () => {
  test("the first by editor order, and the wire prefix round-trips", () => {
    const errors = ruleErrors(rule({ name: "X", tools: ["a b"] }), hosts, []);
    const first = firstFieldError(errors);
    expect(first?.field).toBe("name");
    expect(parseFieldError(`name: ${first?.message}`)).toEqual(first);
  });

  test("a message without a field prefix names no field", () => {
    expect(parseFieldError("something broke")).toBeNull();
    expect(parseFieldError("tools: \"x: y\" is listed twice")).toEqual({ field: "tools", message: '"x: y" is listed twice' });
  });
});
