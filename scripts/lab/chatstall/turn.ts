/**
 * The scripted ChatStall turn, shared by the mock provider (mock.ts streams it) and the observer
 * (observe.ts checks the transcript against it). Shape of the reported freeze: a redacted thought,
 * two `grep` calls whose arguments stream slowly, then one `read` call, then a long German
 * Markdown answer with a table, umlauts and an emoji whose UTF-16 surrogate pair is split across
 * two text deltas.
 */

/** Marker in the prompt that makes the mock play the scripted turn (side calls get a short text). */
export const MARKER = "CHATSTALL-LAB";

export const PROMPT = `${MARKER}: Wo entscheidet die App, ob eine Anfrage über den Connector oder direkt an DATEV geht? Suche die Stellen und fasse sie zusammen.`;

/** The pattern of the screenshot (regex text; JSON escapes the backslash). */
export const GREP_PATTERN = "case \\w+ = |function (transport|kind|isDesktop|desktop|online|viaConnector)|DatevRouter";

export interface ToolScript {
	/** Anthropic tool_use id suffix (the mock prefixes a per-request nonce). */
	key: string;
	tool: "grep" | "read";
	intent: string;
	args: Record<string, string>;
	/** input_json_delta chunks and the pause before each one. */
	chunks: number;
	chunkMs: number;
}

export const GREPS: ToolScript[] = [
	{ key: "grep_src", tool: "grep", intent: "Searching transport decisions", args: { pattern: GREP_PATTERN, path: "src" }, chunks: 25, chunkMs: 120 },
	{ key: "grep_app", tool: "grep", intent: "Searching connector routing", args: { pattern: GREP_PATTERN, path: "app" }, chunks: 25, chunkMs: 120 },
];

export const READ: ToolScript = {
	key: "read_router",
	tool: "read",
	intent: "Reading the DATEV router",
	args: { path: "src/DatevRouter.ts" },
	chunks: 6,
	chunkMs: 120,
};

/**
 * Opaque payload of the `redacted_thinking` block. omp 18.14.2 drops that block for custom
 * endpoints (its leaked-thinking healer rebuilds the message from stream events, and a redacted
 * block emits none), so the mock also sends what Anthropic sends for an omitted thought: a
 * `thinking` block without text, closed by a `signature_delta`. That one survives, and hostd's
 * replica shows it as a redacted thought (empty text + signature).
 */
export const REDACTED_DATA =
	"EmwKAhgBEgyChatStallLabRedactedThinkingBlockForTheFreezeReproductionAAAAQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
export const THINK_SIGNATURE =
	"ErUBCkYIBRgCIkDChatStallLabOmittedThinkingSignatureAAAAQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==";

/** How long the omitted thought "thinks" before its signature closes it and the first tool call starts. */
export const THINK_MS = 1500;

export const ROCKET_HIGH = "\uD83D";
export const ROCKET_LOW = "\uDE80";

/** Last line of the final answer: the observer's proof that the whole answer arrived. */
export const FINAL_END = "Ende der Analyse – alles geprüft.";

export const FINAL_ANSWER = [
	"## Ergebnis: Wo die App zwischen Connector und direktem DATEV-Zugriff entscheidet",
	"",
	"Die Entscheidung fällt an genau **einer** Stelle, nämlich in `DatevRouter.route()`. Alle anderen Fundstellen liefern nur die Zutaten: welcher Transport verfügbar ist, ob die App auf dem Desktop läuft und ob der Connector online ist. Kurz gesagt: Größere Änderungen sind nicht nötig, die Logik ist überschaubar.",
	"",
	"### Fundstellen im Überblick",
	"",
	"| Datei | Funktion | Zweck | Ergebnis |",
	"|---|---|---|---|",
	"| `src/transport.ts` | `transport()` | wählt den Transport anhand von `kind` | `connector` oder `direct` |",
	"| `src/transport.ts` | `kind()` | liest die Konfiguration (Äquivalent zu `TransportKind`) | Enum-Wert |",
	"| `src/platform.ts` | `isDesktop()` | prüft, ob die Desktop-Hülle läuft | `true` / `false` |",
	"| `src/platform.ts` | `online()` | fragt den Connector-Status ab (Timeout 1,5 s) | `true` / `false` |",
	"| `src/DatevRouter.ts` | `route()` | **entscheidet** über den Weg der Anfrage | Ziel-URL |",
	"| `app/Connector.swift` | `viaConnector()` | baut die Anfrage für den Connector | `URLRequest` |",
	"",
	"### Ablauf der Entscheidung",
	"",
	"1. `route()` ruft zuerst `isDesktop()` auf. Außerhalb des Desktops gibt es keinen Connector, also geht die Anfrage sofort **direkt** an DATEV.",
	"2. Auf dem Desktop fragt `route()` den Status mit `online()` ab. Ist der Connector erreichbar, gewinnt er – unabhängig davon, was `kind()` sagt.",
	"3. Nur wenn der Connector schweigt, fällt `route()` auf `transport()` zurück; dort entscheidet die gespeicherte Einstellung (`case connector = \"connector\"` bzw. `case direct = \"direct\"`).",
	"4. Fehler beim Status-Check werden nicht weitergereicht, sondern als „offline“ gewertet. Das ist bewusst so, damit die Oberfläche nicht hängt.",
	"",
	"### Auffälligkeiten",
	"",
	"- **Doppelte Abfrage:** `online()` wird bei jeder Anfrage neu ausgeführt. Ein kurzer Cache (etwa 5 s) würde die Wartezeit spürbar verkürzen.",
	"- **Umlaute in Mandantennamen:** Die Swift-Seite kodiert Namen wie „Müller & Söhne“ oder „Straßenbau Weiß“ korrekt als UTF-8; auf der TypeScript-Seite fehlt dafür ein Test.",
	"- **Gemischte Begriffe:** `viaConnector()` und `transport()` benutzen unterschiedliche Namen für denselben Weg. Eine gemeinsame Aufzählung würde Verwechslungen vermeiden.",
	"",
	"### Empfehlung",
	"",
	`Die Logik ist korrekt und gut testbar; mit dem Cache für \`online()\` und einem Test für die Umlaute ist der Pfad startklar ${ROCKET_HIGH}${ROCKET_LOW}. Für die Übergabe an das Team reicht diese Übersicht – Details stehen in den jeweiligen Dateien.`,
	"",
	FINAL_END,
].join("\n");

/** The answer as text deltas: small chunks, with the rocket's surrogate pair split across two. */
export function finalDeltas(): string[] {
	const text = FINAL_ANSWER;
	const split = text.indexOf(ROCKET_HIGH + ROCKET_LOW) + 1;
	const out: string[] = [];
	let i = 0;
	let n = 0;
	while (i < text.length) {
		let end = Math.min(text.length, i + 6 + (n % 9));
		if (i < split && end > split) end = split;
		out.push(text.slice(i, end));
		i = end;
		n++;
	}
	return out;
}

/** Total streaming time of the final answer. */
export const FINAL_MS = 10_000;

/** The JSON text of a tool call's input, split into `n` chunks at arbitrary byte positions. */
export function inputChunks(t: ToolScript, withIntent: boolean): string[] {
	const json = JSON.stringify(withIntent ? { i: t.intent, ...t.args } : t.args);
	const out: string[] = [];
	for (let k = 0; k < t.chunks; k++) out.push(json.slice(Math.floor((k * json.length) / t.chunks), Math.floor(((k + 1) * json.length) / t.chunks)));
	return out;
}
