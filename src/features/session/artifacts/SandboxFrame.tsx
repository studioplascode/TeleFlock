import { ExternalLink, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openLink } from "@/core";
import { Button, Dialog, DialogContent, EmptyState, isAndroid, isTauri, Skeleton, toast } from "@/design";
import { releaseDocument, servesDocuments, stageDocument } from "./native";
import { FRAME_SANDBOX, LINK_PROMPT_GAP_MS, linkPromptAllowed, linkTarget, STATIC_SANDBOX, wrapperDocument } from "./sandbox";

/** The `tfdoc:` URL of a staged wrapper (desktop app), released when the frame goes. */
function useStaged(wrapper: string, on: boolean): { url?: string; error?: string } {
  const [state, setState] = useState<{ for: string; url?: string; error?: string }>({ for: "" });
  useEffect(() => {
    if (!on) return;
    let live = true;
    let staged: string | undefined;
    stageDocument(wrapper).then(
      (url) => {
        staged = url;
        if (live) setState({ for: wrapper, url });
        else releaseDocument(url);
      },
      (e: unknown) => live && setState({ for: wrapper, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
      if (staged) releaseDocument(staged);
    };
  }, [wrapper, on]);
  return state.for === wrapper ? state : {};
}

/**
 * A presented HTML page in its sandbox (`sandbox.ts`): two nested `allow-scripts` frames under a
 * policy that allows no network. A link the user clicks in the page reaches the app as a message;
 * an http(s) link opens in the system browser after the user confirms it here.
 */
export function SandboxFrame({ page, title }: { page: string; title: string }) {
  // Android: no scripts at all (STATIC_SANDBOX); the frame needs no own policy then, so `srcdoc` serves.
  const scripts = !(isTauri() && isAndroid);
  const sandbox = scripts ? FRAME_SANDBOX : STATIC_SANDBOX;
  const wrapper = useMemo(() => wrapperDocument(page, sandbox), [page, sandbox]);
  const served = servesDocuments();
  const staged = useStaged(wrapper, served);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ask, setAsk] = useState<string | null>(null);
  /** Link messages are ignored until then: a page that asks again as soon as a prompt closed. */
  const quietUntil = useRef(0);
  const close = () => {
    setAsk(null);
    quietUntil.current = Date.now() + LINK_PROMPT_GAP_MS;
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const outer = frame.current?.contentWindow;
      // Only the page in this frame (the wrapper's one child) is listened to.
      if (!outer || e.source == null || (e.source !== outer && e.source !== outer.frames[0])) return;
      const link = linkTarget(e.data);
      if (!link) return;
      // A script can post this without a click. A click in the page activates this window and puts
      // the focus on its frame; typing anywhere else in the app activates the window only.
      const allowed = linkPromptAllowed({
        userActive: navigator.userActivation?.isActive,
        frameFocused: document.hasFocus() && document.activeElement === frame.current,
        now: Date.now(),
        quietUntil: quietUntil.current,
      });
      if (!allowed) return;
      if (!link.url) {
        toast({ title: "This link only works inside the page's own folder", description: link.href, status: "idle", duration: 4000 });
        quietUntil.current = Date.now() + LINK_PROMPT_GAP_MS;
        return;
      }
      const url = link.url;
      setAsk((cur) => cur ?? url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const iframe = (props: { src?: string; srcDoc?: string }) => (
    <iframe
      ref={frame}
      title={title}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      allow=""
      className="block h-full w-full flex-1 border-0 bg-white"
      {...props}
    />
  );

  let body;
  if (!served) body = iframe({ srcDoc: wrapper });
  else if (staged.url) body = iframe({ src: staged.url });
  else if (staged.error) body = <EmptyState compact icon={<ShieldCheck />} title="Couldn't show the page" description={staged.error} />;
  else body = <Skeleton className="m-4 h-40 rounded-lg" />;

  return (
    <>
      {!scripts && (
        <div className="shrink-0 border-b border-line bg-ink/[0.04] px-4 py-1.5 text-2xs font-semibold text-mute">
          The page's scripts don't run on Android (charts or tables a script draws stay empty). Open it on the desktop app to see it all.
        </div>
      )}
      {body}
      <Dialog open={ask != null} onOpenChange={(o) => !o && close()}>
        <DialogContent
          title="Open this link in your browser?"
          description="The presented page asked to open it."
          icon={<ExternalLink />}
          width={480}
          // The focus stays out of the page: it may ask again only after the user clicks in it again.
          onCloseAutoFocus={(e) => e.preventDefault()}
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<ExternalLink />}
                onClick={() => {
                  if (ask) openLink(ask);
                  close();
                }}
              >
                Open
              </Button>
            </>
          }
        >
          <p className="rounded-md bg-bg-deep/70 px-3 py-2 font-mono text-[12px] break-all text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">{ask}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
