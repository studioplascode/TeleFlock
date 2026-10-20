/**
 * TeleFlock PoC collab relay — host-private stand-in for wss://my.omp.sh.
 *
 * Wire contract (identical to upstream packages/collab-web/scripts/local-relay.ts):
 * - GET /r/<roomId>?role=host|guest upgrades to a WebSocket (roomId: [A-Za-z0-9_-]{10,64}).
 * - First host creates the room; a second concurrent host → close 4009.
 *   Guest for a missing room → close 4004.
 * - Host BINARY frames: [u32 BE peerId][sealed]; peerId 0 = broadcast to all guests,
 *   N = only guest N. Forwarded byte-for-byte.
 * - Guest BINARY frames: first 4 bytes rewritten to the sender's peerId, forwarded to host.
 * - TEXT control → host: {"t":"peer-joined","peer":N} / {"t":"peer-left","peer":N}.
 * - Host socket closes → TEXT {"t":"room-closed"} to each guest, close 4001, room deleted.
 * - Clients never send TEXT; it is ignored.
 * Additions over upstream (not part of the omp contract): GET /healthz, a JSON
 * line log of connection lifecycle + per-frame sizes on stderr (ciphertext only).
 *
 * Usage: bun .research/poc/relay.ts [--port 7466] [--host 127.0.0.1] [--quiet]
 */

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const HEADER = 4;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
	connectedAt: number;
}
type RelaySocket = Bun.ServerWebSocket<SocketData>;
interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

function arg(name: string, fallback: string): string {
	const argv = Bun.argv.slice(2);
	const i = argv.indexOf(`--${name}`);
	if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
	const eq = argv.find(a => a.startsWith(`--${name}=`));
	return eq ? eq.slice(name.length + 3) : fallback;
}
const port = Number(arg("port", "7466"));
const hostname = arg("host", "127.0.0.1");
const quiet = Bun.argv.includes("--quiet");
const log = (event: string, extra: Record<string, unknown> = {}): void => {
	if (quiet && event === "frame") return;
	console.error(JSON.stringify({ ts: Date.now(), event, ...extra }));
};

const rooms = new Map<string, Room>();
const ROOM_CLOSED = JSON.stringify({ t: "room-closed" });

const server = Bun.serve<SocketData, never>({
	port,
	hostname,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/healthz") {
			return Response.json({ ok: true, rooms: rooms.size, guests: [...rooms.values()].reduce((n, r) => n + r.guests.size, 0) });
		}
		const match = ROOM_PATH_RE.exec(url.pathname);
		const role = url.searchParams.get("role");
		if (!match || (role !== "host" && role !== "guest")) return new Response("not found", { status: 404 });
		const data: SocketData = { roomId: match[1]!, role, peerId: 0, connectedAt: Date.now() };
		if (srv.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	},
	websocket: {
		// Bun defaults made explicit: these are what omp's reference relay inherits.
		idleTimeout: 120,
		sendPings: true,
		maxPayloadLength: 16 * 1024 * 1024,
		open(ws) {
			const { roomId, role } = ws.data;
			if (role === "host") {
				if (rooms.has(roomId)) {
					log("reject-host", { roomId, code: 4009 });
					ws.close(4009, "a host is already connected for this room");
					return;
				}
				rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
				log("host-open", { roomId });
				return;
			}
			const room = rooms.get(roomId);
			if (!room) {
				log("reject-guest", { roomId, code: 4004 });
				ws.close(4004, "no such room");
				return;
			}
			const peerId = room.nextPeerId++;
			ws.data.peerId = peerId;
			room.guests.set(peerId, ws);
			room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			log("guest-open", { roomId, peerId });
		},
		message(ws, message) {
			if (typeof message === "string") return;
			const room = rooms.get(ws.data.roomId);
			if (!room || message.byteLength < HEADER) return;
			const view = new DataView(message.buffer, message.byteOffset, HEADER);
			if (ws.data.role === "host") {
				if (room.host !== ws) return;
				const target = view.getUint32(0, false);
				log("frame", { dir: "h2g", roomId: ws.data.roomId, target, bytes: message.byteLength });
				if (target === 0) for (const guest of room.guests.values()) guest.send(message);
				else room.guests.get(target)?.send(message);
				return;
			}
			view.setUint32(0, ws.data.peerId, false);
			log("frame", { dir: "g2h", roomId: ws.data.roomId, from: ws.data.peerId, bytes: message.byteLength });
			room.host.send(message);
		},
		close(ws, code, reason) {
			const { roomId, role, peerId } = ws.data;
			const room = rooms.get(roomId);
			log("close", { roomId, role, peerId, code, reason });
			if (!room) return;
			if (role === "host") {
				if (room.host !== ws) return; // a rejected duplicate host
				rooms.delete(roomId);
				for (const guest of room.guests.values()) {
					guest.send(ROOM_CLOSED);
					guest.close(4001, "room closed");
				}
				room.guests.clear();
				return;
			}
			if (room.guests.delete(peerId)) room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
		},
	},
});

log("listening", { url: `ws://${hostname}:${server.port}` });
console.log(`tf-relay listening on ws://${hostname}:${server.port}`);

const shutdown = (): void => {
	for (const room of rooms.values()) {
		for (const guest of room.guests.values()) {
			guest.send(ROOM_CLOSED);
			guest.close(4001, "room closed");
		}
		room.host.close(1001, "relay shutting down");
	}
	rooms.clear();
	server.stop(true);
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
