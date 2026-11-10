// Tests for the bridge's 2.5.0 handling of omp ≥ 18.18's ask tool, which asks with one HTML form
// (`formDialog`): the guest flow that offers the form to hostd field by field (docs/bridge-protocol.md
// "Bridge 2.5.0"), the form text each field carries (`about`), and the race against omp's dialog.
// omp's parser and data functions are stood in for by the parsed form and the same rules as omp's
// `@oh-my-pi/pi-tui/html-form/data` (fieldQuestions, choiceValue, textValue, fieldError).
import { describe, expect, test } from "bun:test";
import {
	DialogHub,
	fallbackApproval,
	type FormChoiceField,
	type FormField,
	type FormKit,
	type FormSpec,
	type FormTextField,
	formAbout,
	raceMember,
	runGuestForm,
} from "./teleflock-bridge";

type Json = Record<string, unknown>;

const BACK = "\u0000back";
const OTHER = "Other (type your own)";
const NEXT = "Next →";
/** Lets the flow's promise chain run to its next dialog (a macrotask, as the bridge suite does). */
const tick = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
};
const text = (spans: Array<{ text: string }>) => spans.map(s => s.text).join("");

/** A form flow's `{data}`, as a plain object. */
function formData(result: unknown): Json {
	if (typeof result !== "object" || result === null || !("data" in result) || typeof result.data !== "object" || result.data === null) {
		throw new Error(`not a form result: ${String(result)}`);
	}
	return { ...result.data };
}

/** omp's html-form data rules for the fields these tests use. */
const kit = (form: FormSpec): FormKit => ({
	parse: () => form,
	questions: f => {
		const out = new Map<FormField, string>();
		for (const section of f.sections) {
			let before = "";
			for (const block of section.blocks) {
				if (block.kind !== "field") {
					before = block.kind === "text" ? text(block.spans) : "";
					continue;
				}
				out.set(block.field, text(block.field.label) || before || text(section.title) || block.field.name);
				before = "";
			}
		}
		return out;
	},
	choiceValue: (field, checked, other) => {
		const picked = field.options.flatMap((o, i) => (checked.has(i) && !o.disabled ? [o.value] : []));
		const typed = field.other ? other?.trim() : undefined;
		if (field.multi && field.options.length > 1) return typed ? [...picked, typed] : picked;
		return typed || picked[0];
	},
	textValue: (field, value) => (field.type === "number" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value),
	fieldError: (field, value) => {
		if (field.kind === "choice") return undefined;
		const s = value === undefined ? "" : String(value);
		if (!s.trim()) return field.required ? "Required" : undefined;
		if (field.type === "number" && !Number.isFinite(Number(s))) return "Enter a number";
		return undefined;
	},
});

function hubWithFrames() {
	const frames: Json[] = [];
	let id = 0;
	const hub = new DialogHub(
		() => ++id,
		f => frames.push(f),
	);
	const requests = () => frames.filter(f => f.t === "ui-request").map(f => f.request as Json & { reqId: number });
	const last = () => requests()[requests().length - 1]!;
	return { hub, requests, last };
}

/** omp's own example form (tools/ask.ts), as `parseHtmlForm` reads it, plus a hidden input. */
function sessionForm() {
	const store: FormChoiceField = {
		kind: "choice",
		name: "store",
		label: [],
		multi: false,
		select: false,
		other: true,
		required: false,
		options: [
			{ value: "sqlite", label: [{ text: "SQLite: one file, no new service" }], checked: true, disabled: false },
			{ value: "redis", label: [{ text: "Redis: shared across instances, needs ops" }], checked: false, disabled: false },
		],
	};
	const ttl: FormTextField = { kind: "text", name: "ttl_days", label: [{ text: "Session lifetime (days)" }], type: "number", multiline: false, value: "30", required: false };
	const form: FormSpec = {
		sections: [
			{ title: [], blocks: [{ kind: "text", spans: [{ text: "Sessions live in memory and are lost on restart." }], heading: false }] },
			{ title: [{ text: "Session store" }], blocks: [{ kind: "field", field: store }] },
			{ title: [], blocks: [{ kind: "field", field: ttl }] },
		],
		fields: [store, ttl],
		hidden: [["ticket", "T-1"]],
	};
	return { form, store, ttl };
}

describe("ask form (guest flow)", () => {
	test("each field is a question of the form: ★ on the checked radio, the form's text as `about`, Back, omp's validation, `{data}`", async () => {
		const { form } = sessionForm();
		const { hub, requests, last } = hubWithFrames();
		const p = runGuestForm(hub, kit(form), form, new AbortController().signal);
		await tick();
		expect(requests()[0]).toEqual({
			kind: "select",
			title: "Session store",
			options: ["SQLite: one file, no new service (Recommended)", "Redis: shared across instances, needs ops", OTHER],
			initialIndex: 0,
			selectionMarker: "radio",
			markableCount: 2,
			helpText: "↑/↓ navigate  Enter select  Esc cancel",
			nav: { index: 0, total: 2 },
			about: "Sessions live in memory and are lost on restart.",
			reqId: 1,
		});
		hub.answer(1, "Redis: shared across instances, needs ops");
		await tick();
		expect(last()).toEqual({ kind: "editor", title: "Session lifetime (days)", prefill: "30", nav: { index: 1, total: 2, back: BACK }, reqId: 2 });
		// omp's check: asked again with its error, the typed text kept.
		hub.answer(2, "a\nfew");
		await tick();
		expect(last()).toMatchObject({ kind: "editor", title: "Session lifetime (days) (Enter a number)", prefill: "a few", reqId: 3 });
		// Back reopens the first question with its answer; "Other" ends it with the typed text.
		hub.answer(3, BACK);
		await tick();
		expect(last()).toMatchObject({ kind: "select", initialIndex: 1, nav: { index: 0, total: 2, answer: { choices: ["Redis: shared across instances, needs ops"] } }, reqId: 4 });
		hub.answer(4, OTHER);
		await tick();
		expect(last()).toMatchObject({ kind: "editor", title: "Custom answer: Session store", about: "Sessions live in memory and are lost on restart.", reqId: 5 });
		hub.answer(5, "Postgres");
		await tick();
		expect(last()).toMatchObject({ kind: "editor", title: "Session lifetime (days)", prefill: "a few", reqId: 6 });
		hub.answer(6, "45");
		expect(formData(await p)).toEqual({ ticket: "T-1", store: "Postgres", ttl_days: 45 });
	});

	test("checkboxes toggle one label per round, Next once the field may end; a cancel cancels the form", async () => {
		const tags: FormChoiceField = {
			kind: "choice",
			name: "areas",
			label: [{ text: "Which areas?" }],
			multi: true,
			select: false,
			other: true,
			required: true,
			options: ["Auth", "Search", "Billing"].map(label => ({ value: label.toLowerCase(), label: [{ text: label }], checked: label === "Search", disabled: false })),
		};
		const form: FormSpec = { sections: [{ title: [], blocks: [{ kind: "field", field: tags }] }], fields: [tags], hidden: [] };
		const { hub, last } = hubWithFrames();
		const p = runGuestForm(hub, kit(form), form, new AbortController().signal);
		await tick();
		// One field: no `nav`; required with nothing ticked yet: no Next; the preselected box is the
		// agent's recommendation (★), not an answer of the user's.
		expect(last()).toEqual({
			kind: "select",
			title: "Which areas?",
			options: ["Auth", "Search (Recommended)", "Billing", OTHER],
			selectionMarker: "checkbox",
			checkedIndices: [],
			markableCount: 3,
			helpText: "↑/↓ navigate  Enter toggle  Esc cancel",
			reqId: 1,
		});
		hub.answer(1, "Billing");
		await tick();
		expect(last()).toMatchObject({ options: ["Auth", "Search (Recommended)", "Billing", OTHER, NEXT], checkedIndices: [2], reqId: 2 });
		hub.answer(2, "Auth");
		await tick();
		hub.answer(3, NEXT);
		expect(formData(await p)).toEqual({ areas: ["auth", "billing"] });

		const second = hubWithFrames();
		const cancelled = runGuestForm(second.hub, kit(form), form, new AbortController().signal);
		await tick();
		second.hub.answer(1, undefined);
		expect(await cancelled).toBeUndefined();
	});

	test("a field named __proto__ is a field like any other", async () => {
		const field: FormTextField = { kind: "text", name: "__proto__", label: [{ text: "Odd" }], value: "", required: false };
		const form: FormSpec = { sections: [{ title: [], blocks: [{ kind: "field", field }] }], fields: [field], hidden: [] };
		const { hub } = hubWithFrames();
		const p = runGuestForm(hub, kit(form), form, new AbortController().signal);
		await tick();
		hub.answer(1, "x");
		const data = formData(await p);
		expect(Object.keys(data)).toEqual(["__proto__"]);
		expect(JSON.stringify(data)).toBe('{"__proto__":"x"}');
	});

	test("the form's text as Markdown before each field: intro, headings, lists, tables, code; a legend that is the question is left out", () => {
		const host: FormTextField = { kind: "text", name: "host", label: [{ text: "Host" }], value: "", required: true };
		const port: FormTextField = { kind: "text", name: "port", label: [{ text: "Port" }], type: "number", value: "5432", required: false };
		const mode: FormChoiceField = {
			kind: "choice",
			name: "mode",
			label: [],
			multi: false,
			options: [{ value: "a", label: [{ text: "A" }] }, { value: "b", label: [{ text: "B" }] }],
		};
		const form: FormSpec = {
			sections: [
				{
					title: [],
					blocks: [
						{ kind: "text", spans: [{ text: "Plan" }], heading: true },
						{ kind: "text", spans: [{ text: "Run " }, { text: "migrate", style: "code" }, { text: " first,\nthen " }, { text: "restart", style: "strong" }, { text: "." }] },
						{ kind: "list", items: [[{ text: "backup" }], [{ text: "swap" }]], ordered: true },
						{ kind: "table", rows: [[[{ text: "Env" }], [{ text: "Size" }]], [[{ text: "prod" }], [{ text: "a|b" }]]], headerRows: 1 },
						{ kind: "pre", text: "SELECT 1;" },
					],
				},
				{ title: [{ text: "Database" }], blocks: [{ kind: "field", field: host }, { kind: "field", field: port }] },
				{ title: [], blocks: [{ kind: "text", spans: [{ text: "Which mode?" }] }, { kind: "field", field: mode }, { kind: "text", spans: [{ text: "Nothing runs until you submit." }] }] },
			],
			fields: [host, port, mode],
			hidden: [],
		};
		const about = formAbout(form, kit(form).questions(form));
		expect(about.get(host)).toBe(
			["**Plan**", "Run `migrate` first,  \nthen **restart**.", "1. backup\n2. swap", "| Env | Size |\n| --- | --- |\n| prod | a\\|b |", "```\nSELECT 1;\n```", "**Database**"].join("\n\n"),
		);
		expect(about.get(port)).toBe("**Database**");
		// Its question comes from the text before it; what follows the last field goes with it.
		expect(about.get(mode)).toBe("Nothing runs until you submit.");
	});
});

describe("formDialog race", () => {
	test("hostd's answers win over omp's form dialog, which closes; without omp's form functions the dialog stays omp's", async () => {
		const { form } = sessionForm();
		const { hub } = hubWithFrames();
		const opened: Array<{ signal?: AbortSignal; resolve(v: unknown): void }> = [];
		const omp = {
			formDialog(_html: string, opts?: { signal?: AbortSignal }): Promise<unknown> {
				const { promise, resolve } = Promise.withResolvers<unknown>();
				opened.push({ signal: opts?.signal, resolve });
				opts?.signal?.addEventListener("abort", () => resolve(undefined));
				return promise;
			},
		};
		const p = raceMember(hub, "formDialog", omp.formDialog as never, omp, ["<form>…</form>", { timeout: 60_000 }], fallbackApproval, kit(form));
		expect(p).toBeDefined();
		await tick();
		hub.answer(1, "SQLite: one file, no new service (Recommended)");
		await tick();
		hub.answer(2, "");
		expect(formData(await p)).toEqual({ ticket: "T-1", store: "sqlite", ttl_days: "" });
		expect(opened[0]!.signal?.aborted).toBe(true);
		expect(raceMember(hub, "formDialog", omp.formDialog as never, omp, ["<form>…</form>", {}], fallbackApproval)).toBeUndefined();
		const empty: FormSpec = { sections: [], fields: [], hidden: [] };
		expect(raceMember(hub, "formDialog", omp.formDialog as never, omp, ["<form></form>", {}], fallbackApproval, kit(empty))).toBeUndefined();
	});
});
