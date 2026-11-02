#!/usr/bin/env bun
/**
 * IdleShells lab observer: connects to the lab's tf-devserver like the app does and prints, on
 * every change, the host's `HostInfo.idleShells` (settings, listed shells, last automatic close),
 * the herdr workspaces with their panes (process, agent), and every notification.
 *
 * Usage: bun scripts/lab/idleshells/watch.ts [ws://127.0.0.1:7446/ws?token=…] [seconds]
 * Default URL from the lab's token; runs until killed, or for `seconds`.
 */
const url = process.argv[2] || "ws://127.0.0.1:7446/ws?token=idleshells-lab-token-0123456789";
const seconds = Number(process.argv[3] || 0);
type Json = Record<string, any>;
let state: Json | null = null;
let last = "";

function line(s: string) {
	console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
}

function show() {
	if (!state) return;
	const idle = state.info?.idleShells;
	const ws = (state.workspaces ?? []).map((w: Json) => {
		const panes = w.tabs.flatMap((t: Json) => t.panes).map((p: Json) => `${p.id}:${p.agentId ? `agent(${p.agentId})` : p.process ?? "?"}`);
		return `${w.label}[${panes.join(" ")}]`;
	});
	const text = JSON.stringify({
		idle: idle && { auto: idle.auto, minutes: idle.minutes, shells: idle.shells.map((s: Json) => `${s.workspace} ${s.paneId} ${s.shell} idle ${Math.round((Date.now() - s.idleSince) / 1000)}s${s.lastCommand ? ` last: ${s.lastCommand}` : ""}${s.closesWorkspace ? " (closes workspace)" : ""}`), lastClosed: idle.lastClosed },
		workspaces: ws,
	});
	const key = text.replace(/idle \d+s/g, "");
	if (key === last) return;
	last = key;
	line(text);
}

const sock = new WebSocket(url);
sock.onopen = () => line(`connected ${url}`);
sock.onclose = () => {
	line("closed");
	process.exit(0);
};
sock.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	const ev = msg.event;
	if (!ev) return;
	if (ev.type === "hostSnapshot") {
		state = ev.state;
		show();
	} else if (ev.type === "hostPatch" && state) {
		for (const op of ev.ops) {
			if (op.op === "info") state.info = op.info;
			else if (op.op === "workspace") {
				state.workspaces = state.workspaces.filter((w: Json) => w.id !== op.id);
				if (op.value) state.workspaces.push(op.value);
				state.workspaces.sort((a: Json, b: Json) => a.order - b.order);
			}
		}
		show();
	} else if (ev.type === "notify") {
		line(`notification: ${JSON.stringify(ev.notification ?? ev)}`);
	}
};
if (seconds > 0) setTimeout(() => process.exit(0), seconds * 1000);
