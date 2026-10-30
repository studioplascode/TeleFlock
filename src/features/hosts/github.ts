import { useEffect, useState } from "react";
import { core } from "@/core";
import type { GhAuthStatus, SetupStatus } from "@/core/gen";
import { errorMessage, isApiError } from "@/features/shell/errors";

/** A tf-hostd that predates the GitHub items (`gh.*Auth*`, `git.identity`) answers this. */
export function isUnknownMethod(err: unknown): boolean {
  return isApiError(err) && err.code === "unknown_method";
}

/** The signed-in account to show: the first working one (active first, as tf-hostd lists them). */
export function ghLogin(s: GhAuthStatus): string | undefined {
  const a = s.accounts.find((x) => x.ok);
  return a && (a.host === "github.com" ? a.login : `${a.login} (${a.host})`);
}

export interface IdentityError {
  /** The form field it is about; `null`: the whole form. */
  field: "name" | "email" | null;
  text: string;
}

/** `git.setIdentity`'s `invalid_params` names its field first (`email: needs an @ …`). */
export function identityError(err: unknown): IdentityError {
  const message = errorMessage(err);
  const m = /^(name|email): (.*)$/s.exec(message);
  if (!m?.[1] || !isApiError(err) || err.code !== "invalid_params") return { field: null, text: message };
  const text = m[2] ?? "";
  return { field: m[1] as "name" | "email", text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/** What `gh.authStatus` adds to the checklist. */
export interface GhAuthView {
  /** The signed-in account, for the "GitHub CLI signed in" row (`octocat`, `me (ghe.example.com)`). */
  login?: string;
  /** This tf-hostd can't sign in from the app. */
  unsupported: boolean;
}

/** `gh.authStatus` whenever the checklist reports gh (`ghSignedIn` present), read again with every checklist. */
export function useGhAuth(hostId: string, status: SetupStatus | null): GhAuthView {
  const [view, setView] = useState<GhAuthView & { hostId?: string }>({ unsupported: false });
  const reported = status?.ghSignedIn !== undefined;
  useEffect(() => {
    if (!status || !reported) return;
    let live = true;
    core
      .host(hostId)
      .call("gh.authStatus", {})
      .then(
        (s) => live && setView({ hostId, unsupported: false, login: ghLogin(s) }),
        (err: unknown) => live && setView({ hostId, unsupported: isUnknownMethod(err) }),
      );
    return () => {
      live = false;
    };
  }, [hostId, status, reported]);
  return view.hostId === hostId ? view : { unsupported: false };
}
