import { describe, expect, test } from "bun:test";
import type { AppInfo, ConnStatus, HostProfile } from "@/core/gen";
import { connDiagnostics } from "./connDiagnostics";

const app = { version: "0.7.0", platform: "windows", hostdVersion: "0.7.0" } as AppInfo;
const wsl = { id: "w", name: "Work laptop", kind: "wsl", distro: "Ubuntu" } as HostProfile;
const failed: ConnStatus = {
  phase: "error",
  since: Date.UTC(2026, 9, 29, 13, 58),
  attempt: 1,
  error: {
    code: "deploy_failed",
    message: "upload bin/tf-hostd failed (exit 2): sha256sum: 4: Syntax error: Unterminated quoted string",
    hint: "Retrying would fail the same way.",
    retryable: false,
  },
};

describe("connDiagnostics", () => {
  test("a failed deploy names the app, the host, the state and the host's own error", () => {
    expect(connDiagnostics({ profile: wsl, status: failed, app })).toBe(
      [
        "TeleFlock connection diagnostics",
        "App: TeleFlock 0.7.0 (windows), bundled tf-hostd 0.7.0",
        "Host: Work laptop (wsl, WSL · Ubuntu)",
        "State: error since 2026-10-29T13:58:00.000Z, attempt 1",
        "Error: deploy_failed",
        "upload bin/tf-hostd failed (exit 2): sha256sum: 4: Syntax error: Unterminated quoted string",
        "Hint: Retrying would fail the same way.",
        "",
      ].join("\n"),
    );
  });

  test("SSH hosts say how they sign in; unknowns stay explicit", () => {
    const ssh = { id: "s", name: "forge", kind: "tailscaleSsh", address: "forge.ts.net", user: "aron", auth: "key" } as HostProfile;
    const text = connDiagnostics({ profile: ssh, status: { phase: "error", since: 0, attempt: 0, message: "boom" } });
    expect(text).toContain("Host: forge (tailscaleSsh, key sign-in, aron@forge.ts.net)");
    expect(text).toContain("App: unknown");
    expect(text).toContain("Message: boom");
    expect(text).not.toContain("attempt");
    expect(connDiagnostics({ status: failed })).toContain("Host: unknown");
  });
});
