import { useEffect, useState } from "react";
import { core, pulseBus, toApiError } from "@/core";
import type { Agent, HostMethods } from "@/core/gen";
import { type Status, toast } from "@/design";

export function errorText(e: unknown): { title: string; hint?: string } {
  const err = toApiError(e);
  return { title: err.message, hint: err.hint };
}

export type CallResult<T> = { ok: true; value: T } | { ok: false; value?: undefined };

/** Host call that reports failures as an error toast (honest state: never swallow). */
export async function hostCall<M extends keyof HostMethods>(
  hostId: string,
  method: M,
  params: HostMethods[M]["params"],
  opts: { success?: string; failure?: string } = {},
): Promise<CallResult<HostMethods[M]["result"]>> {
  try {
    const value = await core.host(hostId).call(method, params);
    if (opts.success) toast({ title: opts.success, status: "done", duration: 2600 });
    return { ok: true, value };
  } catch (e) {
    const { title, hint } = errorText(e);
    toast({ title: opts.failure ?? `${method} failed`, description: hint ? `${title} — ${hint}` : title, status: "error" });
    return { ok: false };
  }
}

/** Tracks one in-flight action so buttons can show a spinner and block double-submits. */
export function usePending(): [boolean, <T>(p: Promise<T>) => Promise<T>] {
  const [n, setN] = useState(0);
  const run = async <T,>(p: Promise<T>): Promise<T> => {
    setN((x) => x + 1);
    try {
      return await p;
    } finally {
      setN((x) => x - 1);
    }
  };
  return [n > 0, run];
}

export function agentStatus(agent: Agent | undefined): Status {
  if (!agent) return "idle";
  if (agent.omp && (agent.omp.link === "error" || agent.omp.link === "unsupported")) return agent.column === "running" ? "running" : "error";
  switch (agent.column) {
    case "needs":
      return "needs-you";
    case "running":
      return "running";
    case "review":
      return agent.turns === 0 && agent.state !== "done" ? "idle" : "review";
    case "done":
      return "done";
  }
}

/**
 * Monotonic event counter for one agent, fed by the imperative pulse bus. State updates are
 * batched to ≤ 5 Hz so a streaming agent never re-renders its subscribers per token.
 */
export function useBeat(key: string): number {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    let pending = 0;
    let timer: number | undefined;
    const off = pulseBus.subscribe(key, (p) => {
      pending += Math.max(1, Math.min(p.n, 6));
      timer ??= window.setTimeout(() => {
        timer = undefined;
        const add = pending;
        pending = 0;
        setBeat((b) => b + add);
      }, 200);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [key]);
  return beat;
}

export interface PendingImage {
  mime: string;
  /** Base64 payload (no data: prefix). */
  data: string;
  /** data: URL for the thumbnail. */
  preview: string;
}

export async function fileToImageInput(file: File): Promise<PendingImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const mime = file.type || "image/png";
  const data = btoa(bin);
  return { mime, data, preview: `data:${mime};base64,${data}` };
}
