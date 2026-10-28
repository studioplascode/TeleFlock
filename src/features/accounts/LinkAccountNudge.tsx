import { KeyRound, X } from "lucide-react";
import { motion } from "motion/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { navigate, useHosts } from "@/core";
import type { LoginProvider } from "@/core/gen";
import { Button, cn, IconButton, useIsMobile } from "@/design";
import { noticeRise, noticeRow } from "@/features/board/notice";
import { linkProviderFor, providerName } from "./providers";
import { type AccountsNeed, useAccountsNeeded, useAccountsStore } from "./store";

/** Hosts whose board nudge the user hid (the host card keeps showing it). */
const useHiddenNudges = create<{ hostIds: string[]; hide(hostId: string): void }>()(
  persist((set) => ({ hostIds: [], hide: (hostId) => set((s) => ({ hostIds: [...s.hostIds, hostId] })) }), { name: "tf.accounts.nudge" }),
);

interface NudgeText {
  /** Host card callout. */
  title: string;
  detail: string;
  /** Board row, after the host name. */
  line: string;
  action: string;
  /** Re-link this provider; absent: open the provider picker. */
  provider?: string;
}

function textOf(need: AccountsNeed, providers: readonly LoginProvider[] | undefined, host: string): NudgeText {
  const expired = need.expired[0];
  if (expired) {
    const name = providerName(expired.provider, providers);
    return {
      title: `Your ${name} login expired`,
      detail: `omp on ${host} can't run agents until you link ${expired.label} again.`,
      line: `your ${name} login (${expired.label}) expired, so omp can't run agents`,
      action: "Re-link",
      provider: providers ? linkProviderFor(expired.provider, providers) : expired.provider,
    };
  }
  return {
    title: "Link an account to run agents",
    detail: `omp on ${host} has no subscription or API key to work with yet. Link ChatGPT, Claude, Copilot, Gemini or an API key.`,
    line: "omp has no subscription or API key yet, so agents can't run",
    action: "Link account",
  };
}

/**
 * Tells a new user why nothing will run: omp on this host has no account (or only expired logins).
 * `row`: one line of the board's notice box (dismissible); `card`: a callout on the host card.
 */
export function LinkAccountNudge({ hostId, variant = "row", className }: { hostId: string; variant?: "row" | "card"; className?: string }) {
  const need = useAccountsNeeded(hostId);
  const host = useHosts((s) => s.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const providers = useAccountsStore((s) => s.hosts[hostId]?.snapshot?.providers);
  const hidden = useHiddenNudges((s) => s.hostIds.includes(hostId));
  const hide = useHiddenNudges((s) => s.hide);
  const mobile = useIsMobile();
  if (!need || (variant === "row" && hidden)) return null;
  const t = textOf(need, providers, host);
  const go = () => navigate({ name: "accounts", hostId, link: t.provider ?? "" });
  if (variant === "card")
    return (
      <div data-nudge="accounts" className={cn("flex items-start gap-3 rounded-lg bg-accent/8 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.32)]", mobile && "flex-col", className)}>
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/18 text-accent-hi">
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{t.title}</p>
          <p className="mt-0.5 text-xs text-mute">{t.detail}</p>
        </div>
        <Button size="sm" variant="primary" icon={<KeyRound />} onClick={go} className={cn("shrink-0", mobile && "w-full")}>
          {t.action}
        </Button>
      </div>
    );
  return (
    <motion.div layout layoutDependency={t.line} {...noticeRise} role="status" data-nudge="accounts" className={cn(noticeRow, "bg-accent/6", className)}>
      <KeyRound className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
      <p className="min-w-0 flex-1 text-mute">
        <b className="text-ink">{host}</b> · {t.line}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="primary" onClick={go}>
          {t.action}
        </Button>
        <IconButton label={`Hide this for ${host}`} size="sm" onClick={() => hide(hostId)}>
          <X />
        </IconButton>
      </span>
    </motion.div>
  );
}
