import { GitPullRequest, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { core, useHosts } from "@/core";
import type { AuthFlow, GitIdentity } from "@/core/gen";
import { RemoteAuthPanel, useRemoteAuth } from "@/features/auth";
import { errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { Ticks } from "@/features/shell/Ticks";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { Button, cn, Field, Input, toast, useIsMobile } from "@/design";
import { type IdentityError, identityError, isUnknownMethod } from "./github";

/**
 * Host setup's GitHub items (`sign-in-gh`, `set-git-identity`; tf-hostd `ops/gh_auth.rs`): the
 * GitHub CLI's sign-in as a device-code flow completed from this device, and git's commit
 * identity. A tf-hostd that predates them answers `unknown_method`: their actions stay hidden and
 * the item's text names the command to run on the host.
 */

/** The `sign-in-gh` item's action (the sheet lives with the checklist: it outlasts the item). */
export function GithubSignInButton({ onClick }: { onClick(): void }) {
  const mobile = useIsMobile();
  return (
    <Button size="sm" variant="primary" icon={<GitPullRequest />} onClick={onClick} className={cn("mt-2", mobile && "w-full")}>
      Sign in to GitHub
    </Button>
  );
}

/** One sign-in: started on mount, cancelled on unmount (closing the sheet). */
function SignInRun({ hostId, setupGit, onDone, onClose }: { hostId: string; setupGit: boolean; onDone(flow: AuthFlow): void; onClose(): void }) {
  const auth = useRemoteAuth({ hostId, start: () => core.host(hostId).call("gh.authStart", { setupGit }), onDone });
  if (auth.stage === "failed" && auth.error?.code === "unknown_method") {
    return (
      <div className="flex flex-col gap-3 py-2 text-sm">
        <p className="text-ink-2">This host's TeleFlock is too old to sign in to GitHub from here.</p>
        <p className="text-xs text-mute">
          <Ticks text="Update TeleFlock on the host (it updates when an updated app reconnects), or run `gh auth login` there." />
        </p>
        <Button variant="ghost" onClick={onClose} className="self-end">
          Close
        </Button>
      </div>
    );
  }
  return <RemoteAuthPanel auth={auth} name="GitHub" icon={<GitPullRequest />} onClose={onClose} doneDetail={auth.flow?.message} />;
}

/**
 * The GitHub CLI's sign-in sheet: first whether git should use the sign-in too (the host needs to
 * know when it starts), then the device code (`gh.authStart`, `RemoteAuthPanel`). Closing it
 * cancels a sign-in still running.
 */
export function GithubSignInSheet({ hostId, open, onOpenChange, onDone }: { hostId: string; open: boolean; onOpenChange(open: boolean): void; onDone(): void }) {
  const host = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const mobile = useIsMobile();
  const [started, setStarted] = useState(false);
  const [setupGit, setSetupGit] = useState(true);
  const checkId = useId();
  const show = (on: boolean) => {
    if (!on) setStarted(false);
    onOpenChange(on);
  };
  const done = (flow: AuthFlow) => {
    haptic("success");
    toast({ title: flow.account ? `Signed in to GitHub as ${flow.account}` : "Signed in to GitHub", description: `Pull request status, checks and merges on ${host} use it now.`, status: "done" });
    onDone();
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={show}
      title="Sign in to GitHub"
      description={`The GitHub CLI signs in on ${host}; you approve it in this device's browser.`}
      icon={<GitPullRequest />}
      width={540}
    >
      {started ? (
        <SignInRun hostId={hostId} setupGit={setupGit} onDone={done} onClose={() => show(false)} />
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2 marker:font-bold marker:text-mute">
            <li>
              <Ticks text={`TeleFlock runs \`gh auth login\` on ${host} and shows you a one-time code.`} />
            </li>
            <li>You enter it at github.com/login/device in this device's browser and authorize GitHub CLI.</li>
            <li>gh keeps the sign-in on {host}; TeleFlock keeps no copy.</li>
          </ol>
          <label htmlFor={checkId} className="flex cursor-pointer items-start gap-2.5 rounded-md bg-white/[0.03] p-2.5 text-xs text-ink-2 shadow-hairline">
            <input id={checkId} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[#a35cf0]" checked={setupGit} onChange={(e) => setSetupGit(e.target.checked)} />
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold">
                <Ticks text="Also use it for git over HTTPS (`gh auth setup-git`)" />
              </span>
              <span className="text-mute">git on {host} then pushes and pulls GitHub repositories with this sign-in.</span>
            </span>
          </label>
          <Button variant="primary" icon={<GitPullRequest />} onClick={() => setStarted(true)} className={cn("self-end", mobile && "w-full")}>
            Get a one-time code
          </Button>
        </div>
      )}
    </ResponsiveDialog>
  );
}

/** git's `user.name` / `user.email` for the host user (`git.identity`, `git.setIdentity`), inline in its setup item. */
export function GitIdentityForm({ hostId, onSaved }: { hostId: string; onSaved(): void }) {
  const mobile = useIsMobile();
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<IdentityError | null>(null);

  useEffect(() => {
    let live = true;
    core
      .host(hostId)
      .call("git.identity", {})
      .then(
        (id: GitIdentity) => {
          if (!live) return;
          setIdentity(id);
          // What git has, else what the GitHub account suggests; never over what was typed meanwhile.
          setName((n) => n || id.name || id.suggestedName || "");
          setEmail((e) => e || id.email || id.suggestedEmail || "");
        },
        (err: unknown) => {
          if (!live) return;
          if (isUnknownMethod(err)) setUnsupported(true);
          else setLoadError(errorMessage(err));
        },
      );
    return () => {
      live = false;
    };
  }, [hostId]);

  if (unsupported) return null;
  const suggested = identity?.suggestedName && identity.suggestedEmail ? { name: identity.suggestedName, email: identity.suggestedEmail } : null;
  const offerSuggestion = suggested && (name.trim() !== suggested.name || email.trim() !== suggested.email);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    core
      .host(hostId)
      .call("git.setIdentity", { name, email })
      .then(
        (id: GitIdentity) => {
          haptic("success");
          toast({ title: "git name and email set", description: `${id.name ?? name.trim()} <${id.email ?? email.trim()}>`, status: "done" });
          onSaved();
        },
        (err: unknown) => {
          haptic("warning");
          if (isUnknownMethod(err)) setUnsupported(true);
          else setError(identityError(err));
        },
      )
      .finally(() => setSaving(false));
  };

  return (
    <form onSubmit={save} noValidate className="mt-2 flex flex-col gap-2.5 rounded-md well p-2.5" aria-label="git name and email">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Name" error={error?.field === "name" ? error.text : undefined}>
          {(id) => (
            <Input
              id={id}
              value={name}
              autoComplete="name"
              placeholder="Your Name"
              invalid={error?.field === "name"}
              onChange={(e) => {
                setName(e.target.value);
                if (error?.field === "name") setError(null);
              }}
            />
          )}
        </Field>
        <Field label="Email" error={error?.field === "email" ? error.text : undefined}>
          {(id) => (
            <Input
              id={id}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              placeholder="you@example.com"
              invalid={error?.field === "email"}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error?.field === "email") setError(null);
              }}
            />
          )}
        </Field>
      </div>
      {error && !error.field && (
        <p className="text-xs font-semibold text-error" role="alert">
          {error.text}
        </p>
      )}
      {loadError && <p className="text-xs text-mute-2">Couldn't read git's current settings: {loadError}</p>}
      <div className={cn("flex flex-wrap items-center gap-2", mobile && "flex-col items-stretch")}>
        <p className="min-w-0 flex-1 text-2xs text-mute-2">
          <Ticks text={`Saved with \`git config --global\`${identity?.file ? ` in ${identity.file}` : ""}.`} />
        </p>
        {offerSuggestion && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<UserRound />}
            onClick={() => {
              setName(suggested.name);
              setEmail(suggested.email);
              setError(null);
            }}
          >
            Use my GitHub identity
          </Button>
        )}
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!name.trim() || !email.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
