import { describe, expect, test } from "bun:test";
import { defaultHostName, versionBelow } from "./kinds";

describe("defaultHostName", () => {
  test("MagicDNS names keep their first label; IPs stay as typed", () => {
    expect(defaultHostName({ kind: "tailscaleSsh", address: "forge.tail1234.ts.net" })).toBe("forge");
    expect(defaultHostName({ kind: "tailscaleSsh", address: " forge " })).toBe("forge");
    expect(defaultHostName({ kind: "tailscaleSsh", address: "100.64.0.7" })).toBe("100.64.0.7");
    expect(defaultHostName({ kind: "tailscaleSsh", address: "fd7a:115c::1" })).toBe("fd7a:115c::1");
    expect(defaultHostName({ kind: "tailscaleSsh", address: "" })).toBe("");
    expect(defaultHostName({ kind: "tailscaleSsh" })).toBe("");
  });

  test("other kinds name themselves", () => {
    expect(defaultHostName({ kind: "wsl", distro: "Ubuntu-24.04" })).toBe("Ubuntu-24.04");
    expect(defaultHostName({ kind: "wsl" })).toBe("WSL");
    expect(defaultHostName({ kind: "local" })).toBe("This computer");
    expect(defaultHostName({ kind: "demo" })).toBe("Demo flock");
  });
});

describe("versionBelow", () => {
  test("compares the first version in the text", () => {
    expect(versionBelow("omp 18.11.9", "18.12")).toBe(true);
    expect(versionBelow("18.12.0", "18.12")).toBe(false);
    expect(versionBelow("omp/18.12.3 linux-x64", "18.12")).toBe(false);
    expect(versionBelow("19.0", "18.12")).toBe(false);
    expect(versionBelow("17.40.1", "18.12")).toBe(true);
  });

  test("no version found is not 'below'", () => {
    expect(versionBelow("not found", "18.12")).toBe(false);
    expect(versionBelow(undefined, "18.12")).toBe(false);
  });
});
