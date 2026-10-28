import { KeyRound } from "lucide-react";
import { core } from "@/core";
import type { McpScope } from "@/core/gen";
import { RemoteAuthPanel, useRemoteAuth } from "@/features/auth";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";

/** The server to sign in to: its name, the file that defines it, the page's project folder. */
export interface SignInTarget {
  name: string;
  scope?: McpScope;
  cwd?: string;
}

/**
 * One OAuth sign-in of an MCP server: omp runs it on the host (`mcp.authStart`), this device's
 * browser approves it, and the redirect reaches the host through the same-port tunnel (or is
 * pasted). Unmounting cancels a sign-in still running: mount one per sign-in.
 */
export function SignInPanel({ hostId, target, onDone, onClose }: { hostId: string; target: SignInTarget; onDone(): void; onClose(): void }) {
  const auth = useRemoteAuth({
    hostId,
    autoOpen: true,
    start: () => core.host(hostId).call("mcp.authStart", { ...(target.cwd ? { cwd: target.cwd } : {}), name: target.name, scope: target.scope }),
    onDone,
  });
  return <RemoteAuthPanel auth={auth} name={target.name} onClose={onClose} />;
}

/** The sign-in in its own sheet (a row's Sign in). Its content unmounts on close, which cancels a running sign-in. */
export function SignInSheet({ hostId, target, open, onOpenChange, onDone }: { hostId: string; target: SignInTarget; open: boolean; onOpenChange(open: boolean): void; onDone(): void }) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Sign in to ${target.name}`}
      description="omp signs in on the host; you approve it in this device's browser."
      icon={<KeyRound />}
      width={540}
    >
      <SignInPanel hostId={hostId} target={target} onDone={onDone} onClose={() => onOpenChange(false)} />
    </ResponsiveDialog>
  );
}
