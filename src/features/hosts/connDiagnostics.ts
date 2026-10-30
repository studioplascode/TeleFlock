import type { AppInfo, ConnStatus, HostProfile } from "@/core/gen";
import { hostAuth, profileAddress } from "./kinds";

/**
 * The text "Copy diagnostics" puts on the clipboard for a connection that failed for good: what a
 * bug report needs (app, host, state, the error with the host's own output). Profiles carry no
 * secrets, so nothing here does either.
 */
export function connDiagnostics({ profile, status, app }: { profile?: HostProfile; status: ConnStatus; app?: AppInfo }): string {
  const how = profile?.kind === "tailscaleSsh" ? `, ${hostAuth(profile)} sign-in` : "";
  const lines = [
    "TeleFlock connection diagnostics",
    `App: ${app ? `TeleFlock ${app.version} (${app.platform}), bundled tf-hostd ${app.hostdVersion}` : "unknown"}`,
    `Host: ${profile ? `${profile.name} (${profile.kind}${how}, ${profileAddress(profile)})` : "unknown"}`,
    `State: ${status.phase} since ${new Date(status.since).toISOString()}${status.attempt ? `, attempt ${status.attempt}` : ""}`,
  ];
  if (status.hostdVersion) lines.push(`tf-hostd on the host: ${status.hostdVersion}`);
  const err = status.error;
  if (err) {
    lines.push(`Error: ${err.code}${err.retryable ? " (retryable)" : ""}`, err.message);
    if (err.hint) lines.push(`Hint: ${err.hint}`);
  } else if (status.message) {
    lines.push(`Message: ${status.message}`);
  }
  return `${lines.join("\n")}\n`;
}
