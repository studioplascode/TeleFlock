#!/usr/bin/env bun
/**
 * IdleShells lab: one host method on the lab host through its tf-devserver, the way the app calls
 * it; prints the answer. With `--hold <seconds>` the connection (and a terminal `term.open`
 * opened) stays open that long, so the pane counts as shown in a TeleFlock terminal.
 *
 * Usage: bun scripts/lab/idleshells/call.ts <method> '<params json>' [--hold <seconds>]
 *   e.g. call.ts term.open '{"target":{"kind":"pane","paneId":"w4:p1"},"mode":"observe","cols":80,"rows":24}' --hold 900
 *        call.ts cleanup.idleShellsSet '{"auto":true}'
 */
const [method, raw = "{}", flag, secs] = process.argv.slice(2);
if (!method) {
	console.error("usage: call.ts <method> '<params json>' [--hold <seconds>]");
	process.exit(64);
}
const hold = flag === "--hold" ? Number(secs) : 0;
const url = process.env.LAB_WS || "ws://127.0.0.1:7446/ws?token=idleshells-lab-token-0123456789";
const sock = new WebSocket(url);
sock.onopen = () => sock.send(JSON.stringify({ id: 1, hostId: "lab", method, params: JSON.parse(raw) }));
sock.onmessage = (m) => {
	const msg = JSON.parse(String(m.data));
	if (msg.id !== 1) return;
	console.log(JSON.stringify(msg.error ? { error: msg.error } : msg.result));
	if (hold > 0) setTimeout(() => process.exit(0), hold * 1000);
	else process.exit(msg.error ? 1 : 0);
};
sock.onclose = () => process.exit(1);
