import { Globe, Hourglass } from "lucide-react";
import { useState } from "react";
import { core, toApiError, useAgent, useBrowser, useHosts } from "@/core";
import { Button, cn, isAndroid, toast } from "@/design";
import { answerRequest, type RequestChoice } from "./actions";
import { agentRequestView, type RequestAgent, type RequestView, waitingText } from "./requests";

/** This device can host the browser (a computer with TeleFlock; not a phone). */
export function canHostBrowser(): boolean {
  return !isAndroid;
}

/** This device can allow an agent's browser request: a computer whose app core has the browser (else Deny only). */
export function useHostsBrowser(): boolean {
  const status = useBrowser();
  return canHostBrowser() && status != null;
}

/**
 * Answers a request: through this device's browser when it has the request; a Deny also works
 * from any device through the agent's host (`agent.answer`), which needs no browser.
 */
async function answer(view: RequestView, choice: RequestChoice, overCap: boolean): Promise<boolean> {
  if (view.phase !== "elsewhere") return answerRequest(view.requestId, choice, overCap);
  try {
    // The need's options are `session`, `turn` and `deny`, as its notification's actions answer them.
    await core.host(view.hostId).call("agent.answer", { agentId: view.agentId, requestId: view.requestId, answer: { choices: [choice], cancel: false, chat: false } });
    return true;
  } catch (e) {
    const err = toApiError(e);
    toast({ title: "Couldn't answer the request", description: err.message, status: "error" });
    return false;
  }
}

/** Allow for this session / Allow once / Deny, or Allow anyway / Deny while it waits at the cap. */
export function RequestButtons({ view, size = "sm", className }: { view: RequestView; size?: "sm" | "md"; className?: string }) {
  const [busy, setBusy] = useState<RequestChoice | "anyway" | null>(null);
  const run = (choice: RequestChoice, overCap = false) => {
    setBusy(overCap ? "anyway" : choice);
    void answer(view, choice, overCap).finally(() => setBusy(null));
  };
  if (view.phase === "waiting") {
    return (
      <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
        <Button size={size} variant="sunset" loading={busy === "anyway"} disabled={busy != null} onClick={() => run(view.scope ?? "session", true)}>
          Allow anyway
        </Button>
        <Button size={size} variant="ghost" loading={busy === "deny"} disabled={busy != null} onClick={() => run("deny")}>
          Deny
        </Button>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {view.phase === "ask" && (
        <>
          <Button size={size} variant="sunset" loading={busy === "session"} disabled={busy != null} onClick={() => run("session")}>
            Allow for this session
          </Button>
          <Button size={size} variant="secondary" loading={busy === "turn"} disabled={busy != null} onClick={() => run("turn")} title="Until the agent's turn ends">
            Allow once
          </Button>
        </>
      )}
      <Button size={size} variant="ghost" loading={busy === "deny"} disabled={busy != null} onClick={() => run("deny")}>
        Deny
      </Button>
    </div>
  );
}

/** The request as a question: the agent, why it asks, what allowing means, and the answers. */
export function RequestCard({ view, hostName, compact = false }: { view: RequestView; hostName?: string | null; compact?: boolean }) {
  const waiting = view.phase === "waiting";
  return (
    <div className={cn("rounded-tile bg-[linear-gradient(180deg,var(--color-sheet-1),var(--color-sheet-2))] shadow-[var(--shadow-d2),inset_0_0_0_1px_color-mix(in_srgb,var(--color-sun-1)_45%,transparent)]", compact ? "p-3" : "p-4")}>
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sun/15 text-sun-ink">{waiting ? <Hourglass className="size-4" /> : <Globe className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">
            {view.agentName}
            {hostName ? <span className="font-semibold text-mute"> on {hostName}</span> : null} wants to use your browser
          </p>
          {view.reason && <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">{view.reason}</p>}
          <p className="mt-1.5 text-xs text-mute">
            {waiting
              ? `${waitingText(view.using, view.cap)}. It gets the browser when you detach one of them.`
              : view.phase === "elsewhere"
                ? isAndroid
                  ? "Allow it from TeleFlock on a computer: the browser runs there."
                  : "This TeleFlock can't run the browser: allow it from TeleFlock 0.9 or later on a computer."
                : "It gets its own tabs in your browser, signed in as you. It can't see your tabs unless you lend one."}
          </p>
          <RequestButtons view={view} className="mt-3" />
        </div>
      </div>
    </div>
  );
}

/** The session's card for its agent's request (it has no question card of its own: hostd asks no dialog). */
export function SessionBrowserRequest({ agent, hostName }: { agent: RequestAgent; hostName?: string | null }) {
  const status = useBrowser();
  // A core without the browser (status unknown) can only deny, like a phone.
  const view = agentRequestView(agent, status, useHostsBrowser());
  if (!view) return null;
  return <RequestCard view={view} hostName={hostName} />;
}

/** Above a session's composer while its agent asks for the browser. */
export function SessionBrowserAsk({ agentKey, className }: { agentKey: string; className?: string }) {
  const agent = useAgent(agentKey);
  const multi = useHosts((h) => h.profiles.length > 1);
  const hostName = useHosts((h) => (agent ? (h.profiles.find((p) => p.id === agent.hostId)?.name ?? null) : null));
  if (!agent || !(agent.needs?.browser || agent.browser?.request)) return null;
  return (
    <div className={className}>
      <SessionBrowserRequest agent={agent} hostName={multi ? hostName : null} />
    </div>
  );
}
