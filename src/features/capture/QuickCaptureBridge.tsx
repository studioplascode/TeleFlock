import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type AgentView, getAgentViews, getHostStates, selectAgentKeys, useCore, useHostStates, useHosts, useSettings } from "@/core";
import { answerAgent, openAnswerHud } from "@/features/board/agentActions";
import { dispatchOptions, hostName, repoNameOf, sendTask } from "@/features/dispatch/send";
import { useDispatch } from "@/features/dispatch/store";
import { needsOptions, optionAnswer } from "@/features/inbox/answers";
import { errorMessage } from "@/features/shell/errors";
import { startShareInbox } from "./androidShare";
import { mainPort, type Port, type ToCapture, type ToMain } from "./link";
import { openPrefilledTask, revealMain } from "./prefill";
import { buildSnapshot } from "./snapshot";

type MainPort = Port<ToMain, ToCapture>;

/**
 * The main window's side of Quick capture (mount once, in `App`): does what the capture window
 * asks (send, open in Dispatch, answer) and, only while that window shows, posts it what to show.
 * Also takes Android shares into Dispatch.
 */
export function QuickCaptureBridge() {
  const [port] = useState(mainPort);
  // Bumped by every hello: a window that just opened gets the picture even when nothing changed.
  const [hello, setHello] = useState(0);
  const [watching, setWatching] = useState(false);

  useEffect(() => startShareInbox(), []);
  useEffect(() => {
    if (!port) return;
    const off = port.listen((msg) => {
      if (msg.kind === "hello") {
        setWatching(true);
        setHello((n) => n + 1);
      } else if (msg.kind === "bye") setWatching(false);
      else void handle(port, msg);
    });
    port.post({ kind: "ready" });
    return off;
  }, [port]);

  return port && watching ? <CaptureFeed port={port} hello={hello} /> : null;
}

/** Needs-you agents, oldest request first (as `useInbox`), as views. */
function useInboxViews(): AgentView[] {
  return useCore(useShallow((s) => selectAgentKeys(s, { column: "needs" }).flatMap((k) => s.agents[k] ?? [])));
}

/** Mounted only while the capture window shows: posts the picture whenever it changes. */
function CaptureFeed({ port, hello }: { port: MainPort; hello: number }) {
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const loaded = useHosts((s) => s.loaded);
  const states = useHostStates();
  const threads = useDispatch((s) => s.threads);
  const remotes = useDispatch((s) => s.remotes);
  const bases = useDispatch((s) => s.bases);
  const legacyBases = useDispatch((s) => s.legacyBases);
  const lastHost = useDispatch((s) => s.lastHost);
  const lastRepo = useDispatch((s) => s.lastRepo);
  const inbox = useInboxViews();
  const snapshot = useMemo(
    () => buildSnapshot({ profiles, status, states, dispatch: { threads, remotes, bases, legacyBases }, loaded, lastHost, lastRepo, inbox }),
    [profiles, status, states, threads, remotes, bases, legacyBases, loaded, lastHost, lastRepo, inbox],
  );
  const last = useRef({ hello: -1, json: "" });
  useEffect(() => {
    // Host patches rebuild the picture often; only what the window would show differently goes out.
    const json = JSON.stringify(snapshot);
    if (last.current.hello === hello && last.current.json === json) return;
    last.current = { hello, json };
    port.post({ kind: "state", snapshot });
  }, [port, snapshot, hello]);
  return null;
}

/** One request from the capture window, answered with `done`. */
async function handle(port: MainPort, msg: Exclude<ToMain, { kind: "hello" | "bye" }>): Promise<void> {
  const done = (ok: boolean, title: string, detail?: string) => port.post({ kind: "done", id: msg.id, ok, title, ...(detail ? { detail } : {}) });
  switch (msg.kind) {
    case "send": {
      const d = useDispatch.getState();
      const { profiles, status } = useHosts.getState();
      const world = { profiles, status, states: getHostStates(), dispatch: d };
      const sent = sendTask(world, {
        target: msg.target,
        repo: msg.repo,
        prompt: msg.text,
        images: msg.images.map(({ mime, data }) => ({ mime, data, preview: `data:${mime};base64,${data}` })),
        options: dispatchOptions(d.options, useSettings.getState()),
      });
      if (!sent.ok) {
        done(false, sent.title, sent.description);
        return;
      }
      // The next capture (and Dispatch) start where this one went.
      d.select(msg.target, msg.repo);
      done(true, `Dispatched to ${repoNameOf(world, msg.target, msg.repo)}`, `A fresh worktree and agent on ${hostName(profiles, sent.hostId)}`);
      return;
    }
    case "edit":
      await openPrefilledTask({ text: msg.text, images: msg.images, source: "capture" }, msg.target && msg.repo ? { target: msg.target, repo: msg.repo } : undefined);
      done(true, "Opened in Dispatch");
      return;
    case "answer": {
      const agent = getAgentViews().find((a) => a.key === msg.agentKey);
      const needs = agent?.needs;
      const option = needs && needs.requestId === msg.requestId ? needsOptions(needs).find((o) => o.id === msg.optionId) : undefined;
      if (!agent || !option) {
        done(false, "That question isn't waiting any more", "It was answered or changed meanwhile.");
        return;
      }
      try {
        await answerAgent(agent.key, msg.requestId, { chat: false, ...optionAnswer(option.id) });
        done(true, `Answered ${agent.name}`, option.label);
      } catch (e) {
        done(false, `Couldn't answer ${agent.name}`, errorMessage(e));
      }
      return;
    }
    case "open":
      openAnswerHud(msg.agentKey);
      revealMain();
      done(true, "Opened in TeleFlock");
  }
}
