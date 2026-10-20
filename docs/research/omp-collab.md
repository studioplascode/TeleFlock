# omp Collab as TeleFlock's structured channel: wire spec, end-to-end proof, verdict

Status: Phase A research. Owner: ResearchOmpCollab. Date: 2026-10-20.
Versions: omp 18.12.3, `@oh-my-pi/pi-wire` 18.12.3, `COLLAB_PROTO = 3`, registry protocol `v1`, herdr 0.9.0, bun 1.4.3. Upstream `can1357/oh-my-pi` was at commit `d24971e3` (2026-10-20) when this was written.

Evidence tags:
- `[observed]`: I ran it in lab session `tf-lab-collab`. Raw data is in `docs/research/omp-collab-samples/`.
- `[source]`: I read it in code. Paths are relative to `.research/omp-src/package/src/` (coding-agent), `.research/omp-src/pi-wire/package/src/` (wire), or upstream `packages/collab-web/`.
- `[inferred]`: my own reasoning, not directly verified.

---

## 0. TL;DR

- **Viable. [observed]** A bun/WebCrypto guest joined a stock omp 18.12.3 TUI that was running in a herdr pane, through a 150-line relay on `127.0.0.1`. From the guest it:
  - prompted and aborted;
  - answered an `ask` and a tool approval through `ui-response`;
  - steered a subagent with `agent-cmd`;
  - fetched a subagent transcript;
  - received all session data: streaming text and thinking, tool cards (bash, edit with diff, todo, ask, task), subagent bus and roster, state, entries.

  The whole time, herdr's `agent list` kept tracking `working`, `blocked` and `idle` correctly, including `blocked` while an ask or approval waited for the guest.
- **Latency on localhost is negligible. [observed]**
  - Guest↔host round trip (seal → relay → host → relay → open): p50 0.21 ms, p95 0.30 ms (n=50).
  - Guest `prompt` → `agent_start` echo: 3–6 ms.
  - Guest `abort` → `agent_end`: 14 ms.
  - Guest `ui-response` → `ui-request-end`: 2–7 ms.
  - TUI keystroke (herdr-injected) → guest frame: about 14–21 ms.
- **Enabling sharing without touching global config works:**
  - per-process overlay: `omp --config overlay.yml` or `PI_CONFIG_FILES`, setting `collab.autoStart: control` and `collab.relayUrl: ws://127.0.0.1:<port>` `[observed]`;
  - or inject `/collab ws://127.0.0.1:<port>` into a running TUI `[observed]`.
- **Biggest risk found: bandwidth. [observed]** Every `message_update` frame carries the full accumulated message twice (`assistantMessageEvent.partial` plus `message`), so traffic grows quadratically with answer length:
  - 300 updates in 1.6 s produced 615 KB, where delta-only frames would have been about 47 KB (13×);
  - the ciphertext cannot be compressed (random IV, AES-GCM).

  **Recommendation:** decrypt and compact on the host, inside a small TeleFlock host daemon. Do not ship raw relay frames over the SSH or mobile link (§13).
- **Guest power is limited. [source + observed]**
  - Guests cannot run slash commands. A guest prompt `/switch :low` reached the model as text.
  - Guests cannot choose follow-up over steer.
  - Guests cannot change model or thinking, compact, branch, run `!bash`, and so on.
  - Workaround proven: herdr `agent prompt` plus an extra `send-keys enter` (autocomplete swallows the first Enter). The guest saw `thinking_level_changed`, the entry and the state 21 ms after the Enter.
  - ResearchOmpSurface independently showed a stronger option: a per-process omp extension (`-e`) that exposes structured control (setModel, setThinkingLevel, compact, newSession, …) over a unix socket.
  - **Recommended architecture: collab for the data plane + a companion extension for the control plane.** Keystroke injection is the fallback.

---

## 1. Lab recipe (reproducible)

All mutating work happens in the herdr session `tf-lab-collab`. Every `herdr` call goes through `.research/poc/hl`, which forces `--session tf-lab-collab` and unsets the inherited `HERDR_SOCKET_PATH`. The user's default herdr session and `~/.omp/agent/config.yml` were never modified `[observed: config.yml mtime 2026-09-27; it contains no "collab" key]`.

```bash
.research/poc/run-e2e.sh setup       # lab herdr server, relay :7466, omp TUI pane "collabhost", guest :7467
.research/poc/run-e2e.sh scenarios   # captures golden frames into docs/research/omp-collab-samples/
.research/poc/run-e2e.sh teardown    # kill guest/relay, `herdr session stop` + `delete` tf-lab-collab
```

`run-e2e.sh setup` plus a probe prompt was replayed from scratch and worked: guest joined, agent_end after 1.65 s, RTT p50 0.28 ms `[observed]`.

| PoC file | Purpose |
|---|---|
| `.research/poc/relay.ts` | Relay, wire-compatible with upstream `local-relay.ts`, plus `/healthz` and a JSON lifecycle and frame-size log on stderr |
| `.research/poc/guest.ts` | Guest: link parsing, WebCrypto seal/open, hello and resync. Control API: `POST /send` (any guest frame), `GET /state`, `GET /frames?since=`, `GET /rtt?n=` |
| `.research/poc/scenario.ts` | Drives one scenario through the guest API. Records the frame slice, latency marks and the herdr `agent get` status timeline (150 ms poll). Options: `--answer '{"value":…}'` or `'{"match":"^Approve"}'`, `--answer-delay-ms`, `--abort-after-ms`, `--no-send` |
| `.research/poc/registry.ts` | Speaks the registry IPC directly (snapshot, link, stale generation, bad token) |
| `.research/poc/collab-overlay.yml` | Per-process omp settings overlay (`collab.*`, plus `modelRoles.task` on the cheap model) |
| `.research/poc/hl` | herdr wrapper pinned to the lab session |

The lab herdr server is started as `setsid -f herdr --session tf-lab-collab server </dev/null` (recipe from ResearchHerdr; it must be detached with stdin from `/dev/null`). The omp host is started with `hl agent start collabhost --kind omp --pane w1:p1 -- --config <overlay> --model openai-codex/gpt-6-luna:low`, which is the `tiny` role on this host.

---

## 2. Link format

[source protocol.ts:176-339, wire index.ts:410-438; observed registry-link-*.json]

**Room id.** 16 random bytes, base64url without padding, so 22 characters (`generateRoomId`). The parser accepts `[A-Za-z0-9_-]{10,64}`.

**Room secret.** base64url without padding:
- Full (control) link: `key(32) ‖ writeToken(16)`, 48 bytes, 64 characters.
- View link: `key(32)` only, 43 characters. Links from before write tokens existed parse as view links.

The host verifies the write token in `hello`; the token is not a separate credential in the URL.

**Canonical forms** emitted by `formatCollabLink(relay, roomId, key, token?)`:

| Relay origin | Link |
|---|---|
| `wss://my.omp.sh` (default) | `<roomId>.<secret>` |
| other `wss://host[:port]` | `host[:port]/r/<roomId>.<secret>` |
| `ws://localhost\|127.0.0.1\|[::1][:port]` | `ws://127.0.0.1:7466/r/<roomId>.<secret>` (full URL kept so `ws` is not mis-inferred as `wss`) |

**Browser deep link.** This is what the registry `link` op returns: `<web-base>/#<link>`. `<web-base>` is `collab.webUrl`, or is derived from the relay origin (`ws`→`http`, `wss`→`https`). Observed:

```
http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/r8VGC82KpJmTV1tMNhK7NQ.DrDYs6Ou…(64 chars)
```

**Parser** (`parseCollabLink`), in order:
1. Replace `%23` with `#`.
2. A bare `<id>[.#]<secret>` resolves against the default relay.
3. Text without a scheme gets `wss://`.
4. For an `http(s)` URL with a fragment, parse the fragment recursively; if that succeeds, the fragment wins.
5. Normalize the origin. `ws://` is only allowed for `localhost`, `127.0.0.1`, `::1` and `[::1]`; anything else is rejected with "relay link must be wss://".
6. The path must be `/r/<roomId>` with `.<secret>` inline, or the secret in a legacy `#fragment`.
7. The secret must be valid base64url decoding to 32 or 48 bytes.

Output: `{ wsUrl: "<ws|wss>://host[:port]/r/<roomId>", roomId, key, writeToken? }`.

**Consequences for TeleFlock:**
- The relay must listen on a loopback name. omp refuses plain `ws://` to anything else, and its relay URL has no unix-socket form `[source protocol.ts:195-220]`.
- The Rust parser only needs the `http://…/#ws://127.0.0.1:P/r/<id>.<secret>` form for registry links. Implement the full grammar anyway for pasted links.

---

## 3. Crypto and envelope

[source crypto.ts:1-67, protocol.ts:151-173, relay-client.ts:620-668; observed]

```
WebSocket BINARY message = envelope
  envelope    = peerId:u32 big-endian (4 bytes)  ‖  sealed
  sealed      = iv (12 random bytes)  ‖  AES-256-GCM(key, iv, plaintext, aad = none)  (ciphertext ‖ 16-byte tag)
  plaintext   = UTF-8 JSON of one frame object  ({"t": "...", ...})
```

- **Cipher.** AES-256-GCM via WebCrypto (`importKey("raw", key, "AES-GCM")`). There is no AAD, no key derivation (the link key is the AES key), and no compression. The tag is the WebCrypto default of 128 bits.
- **Nonce.** Fresh `crypto.getRandomValues(12)` per frame. There is no counter and no direction separation. Random 96-bit nonces are fine for the expected frame counts per room (birthday bound around 2^32 frames).
- **No replay or ordering protection.** There are no sequence numbers. The peerId prefix is outside the seal and is rewritten by the relay, so it is unauthenticated. Integrity of routing rests on the relay. A malicious relay could replay or reorder frames or misattribute peers. Acceptable for a host-private relay that we run ourselves `[inferred]`.
- **Decrypt failure:**
  - a guest treats it as fatal ("bad key or corrupted frame"; no reconnect);
  - a host silently drops undecryptable guest frames `[source relay-client.ts:646-656]`.
- **Ordering.** Both sides decrypt serially on a promise chain (`#recvChain`), so dispatch order equals reception order.
- **Overhead per frame:** 4 + 12 + 16 = 32 bytes. Smallest observed host frame: `turn_start` at 75 bytes; `hello`: 112 bytes `[observed]`.
- **Rust.** `aes-gcm` crate (`Aes256Gcm`, 96-bit nonce from `OsRng`), `base64` with `URL_SAFE_NO_PAD`. The WebCrypto output layout `ciphertext‖tag` matches `aes-gcm`'s `encrypt` output `[inferred]`.

---

## 4. Relay protocol (enough to write our own Rust relay)

[source upstream packages/collab-web/scripts/local-relay.ts (whole file), relay-client.ts; observed with .research/poc/relay.ts and /tmp/tf-relay.log]

### 4.1 Endpoints

- **`GET /r/<roomId>?role=host|guest`** with a WebSocket upgrade. `roomId` matches `^[A-Za-z0-9_-]{10,64}$` (no dot; the secret never reaches the relay).
  - Wrong path or role → HTTP 404.
  - Not an upgrade request → HTTP 426.
  - Clients append `?role=` to `wsUrl` themselves (`relay-client.ts:506`).
- **Production-only endpoints** (not needed by omp hosts or guests): `GET /` (web client), `POST /s`, `GET /s/<id>[/raw]` (share blobs), `GET /healthz`. The PoC adds `/healthz` returning `{ok, rooms, guests}`.

### 4.2 Room state machine (per roomId, in memory only)

```
host connects  ── room absent  → create {host, guests: Map<peerId, ws>, nextPeerId: 1}
               ── room present → close(4009 "a host is already connected for this room")  (live room untouched)
guest connects ── room absent  → close(4004 "no such room")      (close is sent AFTER the upgrade completes,
                                                                 so the client's onopen fires first; observed)
               ── room present → peerId = nextPeerId++ ; TEXT to host {"t":"peer-joined","peer":N}
host BINARY    → read u32 BE peerId: 0 ⇒ forward bytes unchanged to every guest; N ⇒ only to guest N (drop if gone)
guest BINARY   → if len ≥ 4: overwrite bytes[0..4] with sender's peerId (u32 BE), forward to host
TEXT from any client → ignored (clients never send TEXT)
guest closes   → remove; TEXT to host {"t":"peer-left","peer":N}
host closes    → delete room; to each guest TEXT {"t":"room-closed"} then close(4001 "room closed")
relay shutdown → each guest: room-closed + 4001; host: close(1001)
```

**Peer ids:**
- start at 1 per room incarnation and increase monotonically;
- the host's id is 0;
- a recreated room (host reconnects after a drop) issues ids from 1 again.

The host treats every reconnect as "room recreated": it forgets all peers and all pending asks and expects guests to send `hello` again `[source relay-client.ts:252-273, host.ts:1046-1072]`.

### 4.3 Close codes

[source relay-client.ts:18-23, 707-742]

| Code | Meaning | Host reaction | Guest reaction |
|---|---|---|---|
| 4001 | room closed (host left) | n/a | **retry** with backoff, and set `retryMissingRoom` |
| 4004 | no such room | n/a | retry **only if** `retryMissingRoom` was set by an earlier 4001; otherwise fatal |
| 4009 | duplicate host | within 150 s of its own drop: retry (cap 5 s backoff, 1 s provisional open); otherwise fatal | n/a |
| 4029 | room full (production relay cap; not in local-relay) | fatal | fatal |
| 1000/1001/1006/other | transient | retry (backoff) | retry (backoff) |

### 4.4 Liveness, timeouts, backoff

[source relay-client.ts:25-75, 555-583; local relay inherits Bun defaults]

**Client heartbeat.** Clients send a WS ping every 15 s. If a socket has heard nothing (not even a pong) for more than 40 s, the client terminates it and treats it as a transient 1006. **The relay must answer pings with pongs.** Bun and tungstenite do this automatically.

**Server side.** The reference relay uses Bun's `idleTimeout` of 120 s and `sendPings`. The production relay retired silent sockets in about 40 s (per the comment). A Rust relay should send a ping every 15–30 s and drop a peer after about 60 s of silence. That releases a dead host quickly, which matters because a reconnecting host gets 4009 until the old socket is retired.

**Reconnect backoff:** `min(1 s · 2^attempt, 30 s) × U(0.75, 1.25)`, reset after a successful open or the first decrypted frame.

**Host first-connect timeout.** 15 s (`CONNECT_TIMEOUT_MS`, host.ts:123). Auto-start then retries on the controller's relaunch backoff (§9.3).

**Guest timeouts.** 30 s for the welcome and 30 s between snapshot chunks (guest.ts:70-79).

### 4.5 Limits

- **Max WS message.** Bun's default `maxPayloadLength` is 16 MiB. Hosts bound every replicated entry or event to 1 MiB of JSON (§5.4), so a 16 MiB relay limit is safe. **Set at least 16 MiB in the Rust relay.**
- **Client send queue:** 256 frames or 16 MiB pending. Overflow is fatal: "send backlog exceeded; restart sharing and rejoin" `[source relay-client.ts:60-61, 302-311]`.
- **WS backpressure.** A client stops writing when `bufferedAmount ≥ 64 KiB` and resumes below 32 KiB, polling every 25 ms.
- The relay has no per-room guest cap in local-relay (4029 is production-only). Adding one (for example 16) to our relay is reasonable.

### 4.6 What the relay sees

Room ids, connect/close events, peer ids, ciphertext sizes and timing. Nothing else.

Log sample from `/tmp/tf-relay.log` `[observed]`:

```json
{"event":"guest-open","roomId":"r8VGC82KpJmTV1tMNhK7NQ","peerId":1}
{"event":"frame","dir":"g2h","from":1,"bytes":112}
{"event":"frame","dir":"h2g","target":1,"bytes":3808}
{"event":"frame","dir":"h2g","target":0,"bytes":152}
```

---

## 5. Session protocol

### 5.1 Join sequence

[observed 00-join.jsonl; source guest.ts:315-372, host.ts:772-828]

```
guest → relay  WS upgrade /r/<roomId>?role=guest
relay → host   TEXT {"t":"peer-joined","peer":1}        (host only records; nothing is sent yet)
guest → host   hello {"t":"hello","proto":3,"name":"teleflock","writeToken":"<b64url 16B>"}   (omit token for view)
host  → guest  welcome            (targeted to peer 1)
host  → guest  snapshot-chunk ×k  (targeted; last one final:true; empty session ⇒ one chunk entries:[] final:true)
host  → guest  ui-request ×m      (targeted; every pending ask, only if writable)
host  → all    event notice "teleflock joined the collab session" (+ " (read-only)")
host  → all    state              (debounced 100 ms, only if changed)
```

**Rejected hellos** get a targeted `error` and no welcome `[observed 13-view-only-guest.jsonl]`:
- `{"t":"error","message":"protocol mismatch: host speaks v3, guest sent v2"}`
- `"Session transition in progress; join again when it completes"`

**Resync without reconnecting.** Send `hello` again on the open socket. The host answers with a fresh `welcome` and full snapshot train; the peer map is keyed by relay peerId, so the guest is not duplicated `[observed: 64 entries / 97 KB in 2 ms]`. omp's own guest re-sends hello on every reconnect and discards any partial snapshot.

**Live-frame gating.** The host mirrors live frames only while at least one guest has said hello (`#broadcastAllowed`). Guests drop non-snapshot frames until their welcome is processed.

### 5.2 Host → guest frames

[source wire index.ts:349-384, protocol.ts:54-96, host.ts; all observed except where noted]

| `t` | Shape | Addressing | Notes |
|---|---|---|---|
| `welcome` | `{proto:3, header:SessionHeader, state:SessionState, agents:AgentSnapshot[], entryCount:number, readOnly?:true}` | targeted | `readOnly` is present only for view peers. `header` = `{type:"session",version:3,id,timestamp,cwd,title?}` |
| `snapshot-chunk` | `{entries:SessionEntry[], final:boolean}` | targeted | Soft cap 512 KiB per chunk; at least one entry per chunk. The guest is complete when `final` is true or it has accumulated `entryCount` entries |
| `entry` | `{entry:SessionEntry}` | broadcast | Durable entries as appended. Types mirrored: `message`, `custom_message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change` (host.ts:103-110). Others (labels, titles, mode entries, …) are **not** mirrored |
| `event` | `{event:AgentSessionEvent}` | broadcast | Only these `type`s: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `notice`, `auto_compaction_start`, `auto_compaction_end`, `auto_retry_start`, `auto_retry_end`, `thinking_level_changed` (host.ts:84-101). **Not mirrored:** `queue_update`, goal or plan events, todo events, TTSR, approval events, … |
| `state` | `{state:SessionState}` | broadcast | Debounced 100 ms and deduplicated by JSON equality. Triggered by agent_start/end, message_end, tool_execution_end, thinking/model change, compaction end, entries, joins and leaves. Every 2 s while streaming. About 3.3 KB, because `model` is the full model object (~30 fields) |
| `bus` | `{channel:"task:subagent:progress"\|"task:subagent:lifecycle", data}` | broadcast | Mirrored task-subagent EventBus at any depth |
| `agents` | `{agents:AgentSnapshot[]}` | broadcast | Debounced 100 ms on AgentRegistry change. Advisors excluded |
| `ui-request` | `{request:{reqId, kind:"select", title, options:(string\|{label,description?})[], initialIndex?, selectionMarker?:"radio"\|"checkbox", checkedIndices?, markableCount?, helpText?} \| {reqId, kind:"editor", title, prefill?}}` | each **writable** peer | `reqId` increases over the process lifetime (never reused) |
| `ui-request-end` | `{reqId}` | each writable peer | Request settled (answered by anyone, locally or by a guest, cancelled, or aborted). Also sent back to a writer whose `ui-response` named an already-settled `reqId` |
| `transcript` | `{reqId, text, newSize, error?}` | targeted | Reply to `fetch-transcript`. `text` is a JSONL slice from `fromByte`, cut at the last `\n` and at most 4 MiB. `newSize` is the next **byte** offset. `error` is terminal ("no transcript available", "transcript entry exceeds transcript fetch cap (4194304 bytes)", fs errors) |
| `bye` | `{reason}` | broadcast | Graceful end. Observed on `/new`: `"session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them"`. The relay then delivers `room-closed` and 4001 |
| `error` | `{message}` | targeted | Rejections and failures. See §5.5 |

`SessionState` [observed]:

```json
{
  "isStreaming": true,
  "isAborting": false,
  "queuedMessageCount": 0,
  "sessionName": "…(omitted when unset)",
  "cwd": "/tmp/tf-collab-work",
  "model": {"id": "gpt-6-luna", "provider": "openai-codex", "name": "GPT-6 Luna", "contextWindow": 272000, "…": "~30 more fields"},
  "thinkingLevel": "low",
  "contextUsage": {"tokens": 7727, "contextWindow": 272000, "percent": 2.84},
  "participants": [
    {"name": "tf-lab-host", "role": "host"},
    {"name": "teleflock", "role": "guest"},
    {"name": "viewer", "role": "guest", "readOnly": true}
  ]
}
```

`AgentSnapshot` [observed]:

```json
{"id": "ReplyOk", "displayName": "task", "kind": "sub", "parentId": "Main", "status": "running|idle|parked|aborted", "hasSessionFile": true, "createdAt": 1792533470523, "lastActivity": 1792533470542}
```

The main agent appears as `{"id":"Main","kind":"main",…}`.

### 5.3 Guest → host frames

[source wire index.ts:328-344, host.ts:702-1242; observed]

| `t` | Shape | Permission | Host action |
|---|---|---|---|
| `hello` | `{proto:3, name, writeToken?}` | any | Registers or re-registers the peer. `canWrite` = timing-safe compare of the 16-byte token. `name` is trimmed and capped at 64 characters, falling back to `guest-<peer>`. Answers with welcome and snapshot (§5.1) |
| `prompt` | `{text, images?:{type:"image",data:b64,mimeType}[]}` | write | `session.promptCustomMessage({customType:"collab-prompt", content, display:true, details:{from:name}, attribution:"user"}, {streamingBehavior:"steer"})`. **Always steer while streaming; never slash-dispatched.** The resulting entry is `custom_message`/`collab-prompt` with `details.from` |
| `abort` | `{}` | write | `session.abort()`, then broadcasts notice `"<name> interrupted"` |
| `agent-cmd` | `{cmd:"chat"\|"kill"\|"revive", agentId, text?}` | write | `chat`: `ensureLive(agentId)` then `prompt(text, steer)`. `kill`: abort, then release with a tombstone. `revive`: `ensureLive`. Errors come back as `error` "agent <id>: …" |
| `fetch-transcript` | `{reqId, agentId, fromByte}` | any (view too) | Replies with `transcript` (targeted) |
| `ui-response` | `{reqId, value?:string}` | write | `value` **must equal one of the option strings exactly** (labels, including sentinels). An omitted `value` means cancel. See §7 |

### 5.4 Size and bounding rules

[source host.ts:123-135, 830-923, replication-shrink.ts:49-111]

- **Per entry or event, at most 1 MiB of UTF-8 JSON** (`MAX_REPLICATED_PAYLOAD_BYTES`). Oversize payloads are shrunk progressively (string cap 64 KiB → 64 B; array head 256 → 1, with a `[…N items elided]` element; depth 1000).
  - An entry that is still too large becomes `custom_message` with `customType:"collab-entry-too-large"`, keeping the original `id`, `parentId` and `timestamp`, plus a `notice` event.
  - An event that is still too large becomes a `notice`.
- **Welcome snapshot over 24 MiB total:** images are stripped from message entries.
- **Snapshot chunks:** soft 512 KiB per chunk.
- **Transcript replies:** at most 4 MiB, ending on complete lines.

### 5.5 Error frames observed or defined

[source host.ts; observed 13-view-only-guest.jsonl]

- `"prompting is disabled on a read-only link"`, and the same for `interrupting`, `agent control` and `responding to ask`
- `"protocol mismatch: host speaks v3, guest sent v2"`
- `"<action> is unavailable until the host finishes starting up"` / `"… until the session transition completes"`
- `"Prompt was not submitted. Please resend it when the host is ready."`
- `"prompt failed: …"`
- `"agent <id>: empty chat message"` / `"…advisor transcripts are read-only"`

### 5.6 Sequencing and resync rules for a guest implementation

1. Send `hello` on every (re)open. Wait up to 30 s for `welcome` (or an `error`). Then accumulate chunks until `final` (30 s between chunks), then render.
2. While loading, buffer or drop live `event`, `entry` and `state` frames. The snapshot plus the next live frames are consistent, because the host serializes the snapshot synchronously before queueing any later live traffic on the same FIFO socket.
3. **Joining mid-turn.** There is no `message_start` for the in-flight assistant message. Synthesize it from the first `message_update.message`, which is the full partial (omp's guest does this).
4. **Rendering.** Use events for live UI and entries for durable state. omp never renders entries directly, to avoid double rendering.
5. **`bye`, or `room-closed` + 4001.** The room is gone:
   - **Session rotation** (`/new`, `/resume`, `/fork`, branch) gives a **new roomId and key** under the same `instanceId` with `generation+1`. Re-discover it through the registry. Retrying the old roomId just loops on 4004 `[observed 14-session-rotation-bye.jsonl]`.
   - **Host reconnect after a relay drop** keeps the **same roomId and key** (`CollabSocket` reuses `wsUrl`), so retrying the same link works `[observed 12-relay-restart.jsonl]`.
6. **Treat 4004 as retryable for a bounded window after any drop**, not only after a 4001. After a relay restart the guest can reconnect before the host re-creates the room. Observed sequence: 1006, 1006, 1006, **4004**, then the host re-opened 165 ms later. omp's own TUI guest treats that 4004 as fatal, because `retryMissingRoom` is only set by 4001 `[source relay-client.ts:720; inferred consequence]`.

---

## 6. Payload catalog for TeleFlock rendering

[observed; files are in docs/research/omp-collab-samples/]

### 6.1 Assistant streaming (`message_update`)

```json
{"t": "event", "event": {"type": "message_update",
  "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "37",
                            "partial": {"role": "assistant", "content": ["…FULL message so far…"], "…": "…"}},
  "message": {"role": "assistant", "content": ["…FULL message so far, again…"], "api": "…", "provider": "…", "model": "…", "usage": {}, "stopReason": "stop", "timestamp": 0}}}
```

- **`assistantMessageEvent.type` values observed:** `text_start`, `text_delta`, `text_end` (`content` = final block text), `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta` (`delta` = raw JSON fragment of the arguments), `toolcall_end`.
- **Text blocks** carry `textSignature`.
- **Thinking blocks** are `{type:"thinking", thinking, thinkingSignature, summary?:true}`.
  - With Codex at `low`, the thinking text was empty: encrypted reasoning, no summary (`01b`).
  - At `medium`, a summary streamed: `thinking_delta` `"**Keeping reminder unchanged**"` (`11`).
- **Errored assistant message** (provider failure): `content:[]`, `stopReason:"error"`, `errorMessage:"Codex error event: Codex is at capacity…"`. It is followed by `auto_retry_start {attempt, maxAttempts:10, delayMs, errorMessage, errorId}`. There were 6 retries in `01b` and `04`, and only **one** `auto_retry_end` and one `agent_end` per user turn, although each retry emits `agent_start` and `turn_start`.
- **Lifecycle events:**
  - `turn_end` = `{message, toolResults}`
  - `agent_end` = `{messages, isTerminal, yielded}` (carries the whole turn's messages)
  - `message_end` on abort carries `stopReason:"aborted"`

### 6.2 Tool cards (`tool_execution_*`)

```json
{"type": "tool_execution_start", "toolCallId": "call_…|fc_…", "toolName": "bash", "args": {"command": "echo hello-from-collab && uname -s", "pty": false, "async": false}, "intent": "Running requested shell command"}
{"type": "tool_execution_update", "toolCallId": "…", "toolName": "bash", "args": {}, "partialResult": {"content": [{"type": "text", "text": "hello-from-collab\n"}], "details": {}}}
{"type": "tool_execution_end", "toolCallId": "…", "toolName": "bash", "result": {"content": [{"type": "text", "text": "hello-from-collab\nLinux\n"}], "details": {"timeoutSeconds": 300, "wallTimeMs": 25.6}}, "isError": false}
```

| Tool | What to read from `result.details` | Sample |
|---|---|---|
| edit | `{diff:" 1\|alpha\n-2\|beta\n+2\|BETA-EDITED\n 3\|gamma", firstChangedLine:2, op:"update", path, oldText, newText}`. `args.input` is the hashline patch | `03` |
| todo | `{op:"init", phases:[{name:"Work", tasks:[{content:"plan", status:"in_progress"}, …]}], storage:"session"}`. **This is the todo state source**: there are no dedicated todo events or state fields | `04` |
| ask | args `{questions:[{id, question, options:[{label}], multi}]}`. Result `"User selected: Blue"`, details `{question, options, multi, selectedOptions:["Blue"]}` | `05` |
| task | Returns immediately with `"Spawned agent \`ReplyOk\` (job \`ReplyOk\`)."`. Details: `{progress:[…], async:{state:"running", jobId}}` | `07` |

**Task subagent flow** (`07`):
- Progress arrives on `bus` frames:
  - `task:subagent:lifecycle` = `{id, agent, status:"started"|"completed"|"failed"|"aborted", sessionFile, parentToolCallId, index, detached}`
  - `task:subagent:progress` = `{index, agent, task, assignment, progress:AgentProgress}`
- The roster arrives on `agents` frames.
- Completion is delivered to the main agent as entry `custom_message`/`async-result`, which starts a new turn.

### 6.3 Other entries and notices

- **Guest prompt entry:** `{"type":"custom_message","customType":"collab-prompt","content":"…","display":true,"details":{"from":"teleflock"},"attribution":"user",…}`
- **Todo reminder:** omp appends `message` entries with `role:"developer"` (`<system-reminder>You stopped with 3 incomplete todo item(s)…`) and runs an extra turn on its own. Expect turns that no user started (`11`).
- **Notices** (`event.type:"notice"`): `"teleflock joined the collab session"`, `"viewer joined the collab session (read-only)"`, `"teleflock interrupted"`, `"<name> left the collab session"`.

---

## 7. Asks, approvals and `ui-response`

[source modes/controllers/extension-ui-controller.ts:630-1108, tools/approval.ts:740-774; observed 05, 05a, 16]

**The local TUI dialog and the guest request race.** The first *answer* wins and cancels the other side; everyone receives `ui-request-end`. A guest that disconnects counts as "unavailable", not as cancel, so the local dialog keeps running. The TUI showed the Ask box while the guest held the request `[observed herdr-tui-during-ask.txt]`.

**`ask` tool, single choice.** One `select`:

```json
{"options": ["Red", "Blue", "Other (type your own)", "Chat about this"], "selectionMarker": "radio", "markableCount": 2, "initialIndex": 0}
```

- Reply `{"t":"ui-response","reqId":2,"value":"Blue"}` → tool result `User selected: Blue` `[observed 05]`.
- **Gotcha [observed 05a]:** `value:"blue"` (wrong case) produced the tool result `"Ask tool was cancelled by the user"` with `isError:true`. Values must be byte-exact option labels.
- **`Other (type your own)`** → the host follows with an `editor` ui-request (`title:"Custom answer: <question>"`). Answer that with free text. Cancelling it returns to the list.
- **`Chat about this`** → the ask resolves as "chat", and the user is expected to prompt.

**`ask` tool, multi choice.** A loop of `select` requests with `selectionMarker:"checkbox"`:
- each answer toggles one label;
- `"Next →"` appears once something is checked and submits;
- each round carries a new `reqId`.

**Multi-question asks** are serial: one request per question `[source 956-1096]`.

**Tool approvals** (`--approval-mode always-ask`) are mirrored as a `select`:

```json
{"title": "Allow tool: bash\nCommand: echo approved-run", "options": ["Approve", "Approve bash for this session", "Deny"]}
```

- `value:"Approve"` ran the command `[observed 16]`.
- Labels come from `approvalChoiceLabels`: grant labels, then `alwaysLabel`s, then `"Approve"` (or `"Approve Once"` when grants exist), then the session label, then `"Deny"`. Any other value **denies**.

**Not mirrored to guests** (per ResearchOmpSurface; source lines cited in their doc): `showHookConfirm` and input dialogs (for example "Exit plan mode?"), the plan-review overlay, the goal menu. TeleFlock must handle those through the companion extension or keystrokes.

**Pending asks in discovery.** `inputRequired:true` and `busy:true` showed in `omp collab list --json`, and herdr reported `blocked`, during the ask `[observed registry-list-input-required.json, herdr-agent-get-blocked.json]`.

---

## 8. Registry: discovery and links

[source collab/registry.ts (whole file); observed registry-*.json]

### 8.1 CLI

```bash
omp collab list --json
# {"version":1,"hosts":[{"instanceId":"7f57a8d35f9f4581","generation":1,"pid":165963,
#   "sessionId":"01a15b4d-6996-774c-9851-97cfcee9bfcf","sessionName":null,"cwd":"/tmp/tf-collab-work",
#   "model":{"provider":"openai-codex","id":"gpt-6-luna"},"startedAt":1792533162706,"participants":1,
#   "relayConnected":true,"inputRequired":false,"busy":false,"access":"control"}]}
omp collab link <instanceId|pid> [--view] --json
# {"version":1,"instanceId":"7f57a8d35f9f4581","generation":1,"access":"control",
#  "url":"http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/<roomId>.<64-char secret>"}
```

- **Exit codes.** An empty result is a success (`"No active Collab hosts."`). An unreadable or symlinked directory, or one owned by another user, is a nonzero exit.
- **Sorting:** `startedAt`, then `pid`, then `instanceId`.
- **Cost.** Each CLI call takes about 70 ms on this host (omp startup) `[observed]`.
- **Error codes for `link`:** `not_found`, `ambiguous` (a PID that matches several hosts), `stale_generation`, `access_unavailable`, `unreachable`.
- **Joining with herdr** (told to ResearchHerdr):
  - herdr's `agent_session.value` path ends in `_<sessionId>.jsonl` and matched `sessionId` exactly `[observed]`;
  - `pid` is the omp process (also available through `herdr pane process-info`).

### 8.2 Files and IPC

[observed]

- **Directory.** `~/.omp/run/collab-hosts/` (mode 0700). It sits under the **profile-independent** base root, so all profiles share it. It is created on the first publication.
- **Per room publication** (`entryId` = 8 random bytes in hex, new on every rotation):
  - `<entryId>.json`, mode 0600: `{"version":1,"instanceId":"7f57a8d35f9f4581","pid":165963,"endpoint":"/root/.omp/run/collab-hosts/2d6b8affd5c118c6.sock","createdAt":1792533162709,"token":"<64 hex>"}`
  - `<entryId>.sock`: a unix socket, or a named pipe on Windows (`ipcEndpoint(dir, entryId)`, relocated under `/tmp/omp-<euid>/` if `sun_path` would overflow)
  - `<entryId>.sock.bind.lock`
- **Publication timing.** A host publishes only **after** its relay connection opens. A host with an unreachable relay is invisible `[observed deadrelay]`. Publication is withdrawn synchronously on stop, and removed by an exit hook on normal shutdown. Crashed entries are pruned by the next lister that sees ENOENT or ECONNREFUSED.
- **Protocol.** Newline-delimited JSON, **one request per connection**. The request is at most 4 KiB, the response at most 64 KiB, with a 1.5 s per-host deadline. Listers use up to 8 workers.

```
→ {"v":1,"token":"<hex from json>","op":"snapshot"}\n
← {"ok":true,"v":1,"snapshot":{…same fields as list rows…}}

→ {"v":1,"token":"…","op":"link","access":"control"|"view","generation":<n>}\n
← {"ok":true,"v":1,"url":"http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/<roomId>.<secret>"}
← {"ok":false,"v":1,"error":"stale_generation"}      // generation ≠ current room's
```

- **Errors:** `malformed_request`, `unsupported_protocol` (v≠1), `authentication_failed`, `snapshot_unavailable` (host ending, session transitioning, or session no longer current), `invalid_operation`, `invalid_access`, `stale_generation`, `access_unavailable`. The generation is checked before the access level.
- **Direct IPC is fast.** Query time was 0.6 ms; the whole bun script took 6 ms. Recommended for the host daemon instead of forking `omp` `[observed .research/poc/registry.ts]`.

### 8.3 `stale_generation` handling

- **When it happens.** `generation` increments each time the process starts a room (`/new`, `/resume`, `/fork`, branching, a room that ended on its own). It is decremented again if a room never opened, so a recovering process still publishes generation 1 first `[source controller.ts:255-262; observed deadrelay host published gen 1]`.
- **What the CLI does.** `omp collab link` lists and links in one process, so it only reports `stale_generation` if a rotation happens in between, or when the old endpoint is gone and the re-list shows a higher generation `[source registry.ts:680-736]`.
- **Observed rotation.** After `/new`: `bye` → `room-closed` → 4001, then a new room 9 ms later with generation 2. The direct IPC `link` with `generation:1` returned `stale_generation` `[observed registry-ipc-stale-after-new.json]`.
- **What TeleFlock should do.** Key cards by `(instanceId, generation)`. On `bye`, 4001 or `stale_generation`: list again, take the new generation, link, and join. The old transcript continues in the new session only if the user resumed it; a new `sessionId` means a different conversation.

---

## 9. Enabling sharing per process (no global config edits)

### 9.1 Per-process settings overlay (recommended for omp started by TeleFlock)

[source omp://config-usage.md "Layers"; observed]

```yaml
# overlay.yml   — loaded with `omp --config overlay.yml …` or PI_CONFIG_FILES=overlay.yml
collab:
  autoStart: control          # off | view | control  (control = registry hands out control links)
  relayUrl: ws://127.0.0.1:7466
  displayName: tf-lab-host     # optional; default OS username
```

- **Precedence:** env-bound setting > runtime override > overlays (`PI_CONFIG_FILES` first, then `--config` in order) > project > global > default.
- **Strictness.** Overlays are strict (a missing file or bad YAML is a hard error) and read-only.
- **Paths** are resolved relative to the project directory.
- **No env shortcuts.** No `collab.*` setting declares an env var; the only env route is `PI_CONFIG_FILES` `[source collab/settings.ts]`.
- **There is no `--collab` CLI flag.**
- **Observed.** `herdr agent start collabhost --kind omp --pane w1:p1 -- --config …/collab-overlay.yml --model …` published `relayConnected:true` within about 3 s of start, without printing anything in the pane.
- **Gotcha [observed].** herdr session restore relaunched the omp pane as `omp --resume=<session.jsonl>` **without** `--config`, so restored sessions are not hosted. Panes started with other args came back as plain shells. Restored sessions need §9.2, or the user's opt-in.

### 9.2 Injecting `/collab ws://127.0.0.1:<port>` into a running TUI

[observed manualhost]

- `herdr agent prompt <agent> "/collab ws://127.0.0.1:7466"` started a control room. It showed up in `omp collab list` as `access:"control"`, `relayConnected:true`.
- **Downside:** it prints the full link and a QR code into the TUI scrollback, which anyone attaching to the pane or using `herdr pane read` can see.
- **Lifecycle with `autoStart: off`:**
  - the room does **not** follow `/new` or `/resume` (rotation stops it and starts nothing);
  - a room that ends fatally stays down `[source controller.ts:299-356]`;
  - so TeleFlock must re-inject after every rotation.
- `/collab view` gives view-only. `/collab stop` stops sharing.

### 9.3 Auto-start when the relay is down or restarts

**Relay unreachable at startup** [observed deadrelay; source controller.ts:275-340]:
- A dim status line "Collab auto-start failed: Failed to connect" appears, and the prompt is not delayed.
- Relaunches follow 0 s, then 1 s, 2 s, 4 s, … up to 60 s. The streak resets after 5 min without a failure.
- The registry shows nothing until the relay connects.
- Observed: relay started 15 s after omp; the room appeared 13.3 s later, generation 1.

**Relay restarts while a room is live** [observed 12-relay-restart]:
- The host socket sees 1006 and reconnects with backoff (relay down 4.2 s; host room re-opened 2.95 s after the relay returned, 7.2 s after the kill, per the relay log).
- It **re-creates the same roomId**, so the link stays valid and the generation is unchanged.
- During the outage `omp collab list` showed `relayConnected:false` and the host stayed listed.
- Guests get 1006 and must reconnect and `hello` again. All pending asks are settled "unavailable" for guests; the local dialog stays.

**Duplicate-host lockout.** If the relay keeps a dead host socket, the reconnecting host gets 4009 until liveness retires the old one (within the 150 s reclaim window). Our relay should therefore detect silent peers fast (§4.4).

### 9.4 Opt-in global setting (user's choice; TeleFlock must ask)

`collab.autoStart: control` plus `collab.relayUrl: ws://127.0.0.1:<port>` in `~/.omp/agent/config.yml` makes **every** interactive omp share, including herdr-restored and user-started sessions. It survives `/new` and `/resume` and relaunches after relay outages.

This is the most robust data-plane setup. It is a user consent decision, not something phase A may do.

**Port stability.** Rooms bake the relay URL in at creation, so TeleFlock's relay port must be **fixed** per host.

---

## 10. End-to-end proof results

[observed; see each `*.summary.json`]

Latencies are ms from the guest's send. "herdr" is the `herdr agent get collabhost` status timeline polled every 150 ms.

| # | Scenario | Key frames | Latency | herdr |
|---|---|---|---|---|
| 00 | join | hello → welcome (3.6 KB) → snapshot-chunk → notice → state | same tick | idle |
| 01 | tiny prompt | agent_start 6, message_update 1310, agent_end 1370 | 6 | idle→working(311)→idle(1848) |
| 01b | streaming + provider retries | 6× auto_retry_start (Codex at capacity), 83 updates, 145 KB | 3 | (retries) |
| 02 | bash | tool_execution_start 1198 → 3 updates → end 1234 | 3 | idle→working→idle |
| 03 | edit with diff | read + edit; `details.diff/oldText/newText` | 3 | idle→working→idle |
| 04 | todo | todo `init` with `details.phases` | 3 | idle→working→idle |
| 05 | ask → ui-response "Blue" (8 s delay) | ui-request 1279, response 9335 → ui-request-end 9337 (2 ms) | 2 | idle→working→**blocked(1390)**→working(9543)→idle |
| 05a | ask, wrong-case value | tool result "Ask tool was cancelled by the user" | — | blocked→working |
| 06 | abort mid-stream | abort sent 2433 → agent_end 2447 (**14 ms**), notice "teleflock interrupted" | 14 | working→idle(2925) |
| 07 | task subagent | bus lifecycle/progress ×7, agents ×2, async-result entry | — | idle→working→idle(6040) |
| 08 | fetch-transcript | 16 KB JSONL slice, `newSize:15670`; unknown agent → error | 2 | — |
| 09 | agent-cmd chat to subagent | bus + agents, then the main agent consumes async-result | 3 | — |
| 10 | herdr-injected `/switch :medium` | entry `thinking_level_change` + event `thinking_level_changed` 21 ms after the Enter; state at +100 ms | 21 | idle |
| 11 | guest prompt `/switch :low` | arrives as collab-prompt text; **no** state change (model answered it) | — | — |
| 12 | relay kill + restart | 1006×3, **4004**, re-hello → re-welcome (97 KB) on the same roomId | — | — |
| 13 | view-only guest + proto v2 hello | welcome `readOnly:true`; 4 error frames | — | — |
| 14 | `/new` rotation | bye → room-closed → 4001; new room 9 ms later, gen 2 | — | — |
| 15 | prompt typed into the TUI via herdr | agent_start 14 ms after `agent prompt` returned | 14 | idle→working→idle |
| 16 | tool approval → "Approve" | select `Approve` / `Approve bash for this session` / `Deny`; ui-request-end in 7 ms | 7 | **blocked(1619)**→working(4845) |

**Pure transport round trip** (`/rtt`: seal → relay → host → relay → open, 50 samples, idle): min 0.17 ms, p50 0.21 ms, p95 0.30 ms, max 0.69 ms `[observed latency-rtt-idle.json]`.

**Decrypt cost.** Average 0.05–0.14 ms per frame; max 3.3 ms for a 16 KB transcript (bun WebCrypto).

**herdr state tracking** keeps working with a guest attached:
- guest prompts drive `working` and `idle` (detected within one 150 ms poll after the host's `agent_start`);
- guest-answerable asks and approvals show as `blocked`;
- `herdr agent list` during the ask showed `agent_status:"blocked"`, terminal title `π ! tf-collab-work` `[observed herdr-agent-list-during-ask.json]`.

**Multiple guests.** A full guest and a view guest were in one room at the same time; participants = 3 `[observed]`.

### Not captured, and why

- A task subagent that itself asks a question: not attempted. Subagent asks are routed through the parent's UI, so this needs an extra spike `[inferred]`.
- `auto_compaction_*`, `compaction` and `branch_summary` entries: not triggered (would need a large context). Shapes come from `[source wire index.ts:135-147, 194-195]`.
- Guest-supplied `images` in `prompt`: not exercised. Shape `[source wire index.ts:23-29]`.
- `agent-cmd kill` and `revive`: not exercised (`chat` was).
- 4009 duplicate host and 4029 room full: not reproduced. 4029 only exists on the production relay.

---

## 11. Guest-power limits and the keystroke workaround

**Guests can:** read everything; `prompt` (steer while streaming); `abort`; answer `select` and `editor` ui-requests; `agent-cmd` chat, kill and revive; `fetch-transcript` `[source host.ts]`.

**Guests cannot** [source omp://collab.md "Guest permission model", host.ts:978-1003; observed 11]:
- run any slash command (prompt text is never dispatched; `/switch :low` went to the model);
- `/model`, `/switch`, thinking level, fast and slow modes, service tier;
- `/compact`, `/new`, `/resume`, `/fork`, `/branch` and tree navigation, `/goal`, `/plan`, plan approval;
- `!bash`, `$python`, skills, `/export`;
- choose follow-up vs steer, see or edit the queue (only `queuedMessageCount`);
- answer confirm or input hook dialogs or the plan-review overlay;
- set the session name.

**Keystroke workaround** [observed 10]:

```bash
herdr --session tf-lab-collab agent prompt collabhost "/switch :medium"
# autocomplete rewrote the composer to "/switch openai-codex/gpt-6-luna:medium" and ate the Enter
herdr --session tf-lab-collab agent send-keys collabhost enter
```

- The guest received `entry thinking_level_change`, `event thinking_level_changed`, then `state.thinkingLevel:"medium"` (+100 ms).
- In the TUI, `/model <arg>` always opens the selector (`handleTui` ignores args); `/switch <model|:level>` applies without one `[source slash-commands/builtin-modes.ts:455-548]`.
- `/new` went through with a single `agent prompt` (no autocomplete).
- **Rules:**
  - Inject only when herdr reports `idle`. `agent prompt` refuses `blocked`.
  - Verify the effect through the collab frames, not the screen.

**Better: a companion extension** (ResearchOmpSurface, `docs/research/omp-samples/tf-bridge-probe.ts`, observed in their lab).
- `omp -e <file>` loads a per-process extension that serves a unix socket with structured calls:
  - `pi.setModel`, `pi.setThinkingLevel`, `pi.setServiceTier`, `pi.setSessionName`;
  - `pi.sendUserMessage(text, {deliverAs:"steer"|"followUp"})`;
  - `ctx.abort()`, `ctx.compact()`;
  - after one injected attach command: `newSession`, `switchSession`, `navigateTree`.
- `[source extensibility/extensions/types.ts:671-846, 1866-1893]` confirms these APIs exist.
- Like `--config`, `-e` is lost on herdr restore, so global opt-in remains the robust path.

---

## 12. Bandwidth: the one serious problem

[observed]

Each `message_update` repeats the full assistant message twice (`assistantMessageEvent.partial` and `message`), so the cost per update grows linearly and the whole stream grows quadratically.

| Sample | All h2g bytes | message_update bytes | Delta-only equivalent | Overhead |
|---|---|---|---|---|
| 06 abort (303 updates in 1.6 s) | 630 KB | 615 KB | 47 KB | 13× |
| 01b | 146 KB | 110 KB | 13 KB | 8.4× |
| 02 bash | 85 KB | 56 KB | 8.3 KB | 6.8× |
| 07 task | 165 KB | 91 KB | 12.8 KB | 7.1× |

- Update rate about 190/s; about 390 KB/s for a 1.6 s answer. A 10 KB answer would cost megabytes `[inferred from growth]`.
- `state` is 3.3 KB every 2 s while streaming.
- **Encryption defeats compression.** Random-IV AES-GCM output is incompressible, so neither WS permessage-deflate nor SSH compression helps.
- **Per guest.** Every additional guest receives the same broadcast.

**Fix in TeleFlock.** Never forward raw relay traffic over the SSH or mobile link. Decrypt on the host, rewrite `message_update` to `{type, contentIndex, delta}` (the full message is only needed after a resync), and forward to the app. That gives roughly an order-of-magnitude reduction.

---

## 13. Verdict and recommended design

### Verdict

**Viable, adopt it for the data plane.** Collab gives TeleFlock a complete, structured, low-latency, end-to-end encrypted mirror of a normal omp TUI running in a herdr pane, while herdr's state tracking keeps working. It also gives prompt, abort, ask and approval answers, and subagent chat, kill and revive.

The hypothesis in `tf-context.md` §2–4 holds, with three amendments:
1. A host-side bridge instead of a raw relay tunnel (bandwidth, §12).
2. A companion extension for control (§11), with herdr keystrokes as the fallback.
3. Explicit handling of herdr restore and of rotation.

### Recommended design

```
host (herdr machine)                                                   app (Windows/Android)
┌───────────────────────────────────────────────────────────────┐
│ omp TUI (herdr pane) ──ws──► tf-hostd relay 127.0.0.1:47466   │
│   (collab.autoStart via overlay / global opt-in / injected)   │      SSH exec channel:
│ omp registry ~/.omp/run/collab-hosts ◄─ipc─ tf-hostd          │◄────  `tf-hostd attach` (stdio,
│                                    tf-hostd guest per session │       length-prefixed frames,
│ (optional) tf companion extension UDS ◄─── tf-hostd control   │       compacted deltas)
└───────────────────────────────────────────────────────────────┘
```

**`tf-hostd`** is one small Rust binary. The app installs it to the host, or runs it from `~/.local/share/teleflock/` after uploading it over SSH.
- **Relay.** Embedded; the §4 contract on a **fixed** loopback port. Pings every 20 s, drops peers after 60 s of silence, 16 MiB max message, `/healthz`.
- **Registry poller.** Direct IPC (§8.2) every 1–2 s, plus inotify on the directory. Emits session-appeared, session-gone and generation-changed events.
- **One guest per hosted session** (Rust, `aes-gcm`). Handles hello, welcome, chunks, resync and rotation (§5.6), and treats 4004 as retryable for 30 s after a drop.
- **Fan-out to the app.** Compacted events, plus the snapshot from a local cache when the app reconnects. Keys and write tokens never leave the host.
- **Control.** Collab frames for prompt, abort, ui-response and agent-cmd. Companion-extension calls, when available, or herdr keystroke injection for TUI-only actions.

**Lifecycle.**
- Start detached: `setsid -f tf-hostd daemon`, single instance via a lock file and the bound port, optionally a `systemd --user` unit.
- It must **outlive app disconnects**: omp hosts depend on the relay, and a dead relay drops every room into the 1–60 s relaunch backoff.
- The app's SSH session only runs `tf-hostd attach` (a stdio bridge to the daemon's UDS).
- Local and WSL modes run the same daemon locally; the app talks to it directly.

**Fallback (thin) option.** If a host daemon is unacceptable: run only the relay on the host and implement the guest in the app's Rust core over `direct-tcpip` to `127.0.0.1:<port>` (Tailscale SSH supports direct-tcpip; per ResearchHerdr, streamlocal is unsupported). The cost is about 10× bandwidth on mobile, and the room keys travel to the device.

### Risks

| Risk | Detail | Mitigation |
|---|---|---|
| Protocol versioning | `hello.proto` must equal the host's `COLLAB_PROTO` exactly (3), otherwise `error` "protocol mismatch". The registry protocol `v` must equal 1. `AgentSessionEvent` and entry payloads are unversioned and grow with every omp release | Version table keyed by omp version (`entry.runtime.version`, observed `"18.12.3"`); surface mismatch as "update TeleFlock"; tolerant parsing with `default:` branches; CI against omp releases; pin `@oh-my-pi/pi-wire` types (MIT) |
| Relay restarts | Rooms resume on the same id; guests must re-hello; asks pending for guests are settled as unavailable | Persistent daemon; fast liveness; bounded 4004 retry |
| Rotation (`/new`, `/resume`, `/fork`, branch) | New roomId and key, `generation+1`, `bye` | Registry re-discovery keyed by `(instanceId, generation)`; with injected `/collab` (autoStart off), re-inject after rotation |
| herdr restore drops `--config` and `-e` | Restored omp is not hosted and has no bridge | Global opt-in (with consent), or inject `/collab` and the attach command after detecting it |
| Multiple guests | Supported; asks race (first answer wins; others get `ui-request-end`); each guest costs full bandwidth on the host | One `tf-hostd` guest per session, shared by all app clients |
| Bandwidth | §12 | Host-side compaction |
| Startup gating | Prompt, abort and agent-cmd are refused until startup finishes (`error` "…unavailable until the host finishes starting up") | Disable the composer until the first successful prompt or `state` |
| Local attackers | Any local user can connect to the loopback relay, but cannot decrypt; the host drops garbage | Bind 127.0.0.1 only; optional per-room guest cap; multi-user hosts are out of scope |
| Proxy environment | `CollabSocket` resolves `getProxyForUrl("collab", url)`. Loopback bypass is documented for provider traffic; unverified for collab | Test with `HTTPS_PROXY` set `[inferred]` |
| Production relay differences | omp's relay contract may evolve (Go source unpublished) | Our relay follows `local-relay.ts`, which omp's own tests target |

### Why not omp RPC in the pane?

`omp --mode rpc` has a much richer control surface (set_model, compact, queues, explicit follow-up, `extension_ui_request` including confirm and input) `[source omp://rpc.md]`. But it owns stdin and stdout, so the pane would no longer show the real TUI. TeleFlock would have to wrap or re-implement the TUI, and herdr's screen-based detection would lose its target `[inferred]`.

Collab plus a companion extension keeps the real TUI, gives about 95% of the structure, and closes the control gaps. **Recommendation: no RPC wrapper for v1.**

---

## 14. Sample index (`docs/research/omp-collab-samples/`)

**Frame logs.** `NN-*.jsonl`: one decrypted frame per line, as `{seq, recvAt(ms), dir: "h2g"|"g2h"|"ctl", bytes (ciphertext envelope), decryptMs?, frame}`.
- `ctl` rows are relay TEXT control messages (`room-closed`) and the PoC's own `ws-close` records.
- `*.summary.json` files hold latency marks, frame counts, bytes and the herdr timeline.
- Files: `00-join`, `01-prompt-text`, `01b-prompt-streaming-thinking`, `02-bash-tool`, `03-edit-tool`, `04-todo`, `05-ask-ui-response`, `05a-ask-wrong-label`, `06-abort`, `07-task-subagent`, `08-fetch-transcript`, `09-agent-cmd-chat`, `10-injected-switch-thinking`, `11-guest-slash-not-executed` (also the visible-thinking sample), `12-relay-restart`, `13-view-only-guest`, `14-session-rotation-bye`, `15-tui-typed-prompt-mirrored`, `16-tool-approval`.

**Registry.**
- `registry-list.json`, `registry-list-input-required.json`, `registry-list-after-new.json`
- `registry-link-control.json`, `registry-link-view.json`
- `registry-ipc-snapshot.txt` (includes `authentication_failed` and `invalid_operation` replies)
- `registry-ipc-stale-generation.json`, `registry-ipc-stale-after-new.json`

**herdr.** `herdr-agent-get-blocked.json`, `herdr-agent-list-during-ask.json`, `herdr-tui-during-ask.txt` (TUI Ask box while the guest held the request).

**Latency.** `latency-rtt-idle.json`.

**Secrets in samples.** All lab rooms are closed and the relay is stopped. Keys and write tokens in these files grant nothing.
