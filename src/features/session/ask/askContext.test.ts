import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/core/gen";
import { CONTEXT_MAX, clipContext, contextFromRows, withoutQuestion } from "./askContext";

const Q = "Where should the gateway read its feature flags from?";

describe("withoutQuestion", () => {
  test("drops trailing paragraphs that only repeat the question, whatever their Markdown, case or spacing", () => {
    expect(withoutQuestion(`Config loads once at startup.\n\n**${Q}**`, Q)).toBe("Config loads once at startup.");
    expect(withoutQuestion(`Config loads once at startup.\n\n## ${Q}\n\n> where SHOULD the gateway\n> read its   feature flags from`, Q)).toBe("Config loads once at startup.");
    expect(withoutQuestion(`Two options.\n\n- ${Q}`, Q)).toBe("Two options.");
  });

  test("a paragraph ending with the question keeps its lead, unless the lead is three words or fewer", () => {
    expect(withoutQuestion(`It reloads on SIGHUP. Which leaves one question: ${Q.toLowerCase()}`, Q)).toBe("It reloads on SIGHUP. Which leaves one question:");
    expect(withoutQuestion(`Config loads once.\n\nSo, ${Q.toLowerCase()}`, Q)).toBe("Config loads once.");
    expect(withoutQuestion(`Config loads once.\n\nMy question: *${Q}*`, Q)).toBe("Config loads once.");
    // emphasis whose closer went with the question is not left open
    expect(withoutQuestion(`**Before wiring flags in, one decision: ${Q}**`, Q)).toBe("Before wiring flags in, one decision:");
  });

  test("a short sentence before the question in its paragraph stays; only the lead-in after it goes", () => {
    // Before, a lead of three words or fewer went whole, sentences included: the card showed only the question.
    expect(withoutQuestion("Tests fail! Should I deploy anyway?", "Should I deploy anyway?")).toBe("Tests fail!");
    expect(withoutQuestion("I ran the migrations.\n\nBuild is green. Should I deploy?", "Should I deploy?")).toBe("I ran the migrations.\n\nBuild is green.");
    expect(withoutQuestion("**Two tests fail.** So, should I deploy?", "Should I deploy?")).toBe("**Two tests fail.**");
    expect(withoutQuestion(`Done. My question: ${Q}`, Q)).toBe("Done.");
    // a list of the questions: the earlier one stays, it is not this question
    expect(withoutQuestion("Two things:\n\n1. Which store?\n2. Which ORM?", "Which ORM?")).toBe("Two things:\n\n1. Which store?");
    // a number ends no sentence: "Step 2." is a lead-in
    expect(withoutQuestion("Step 2. Which store?", "Which store?")).toBe("");
  });

  test("nothing but the question leaves nothing to show", () => {
    expect(withoutQuestion(Q, Q)).toBe("");
    expect(withoutQuestion(`${Q}\n\n**${Q}**`, Q)).toBe("");
  });

  test("the question elsewhere, a longer last paragraph or another question stay", () => {
    const mid = `${Q} I looked at three stores.\n\nThe config file is reviewed in pull requests.`;
    expect(withoutQuestion(mid, Q)).toBe(mid);
    expect(withoutQuestion(`Context.\n\n${Q} Tell me if unsure.`, Q)).toBe(`Context.\n\n${Q} Tell me if unsure.`);
    // "…flags from" is not the end of a different word
    expect(withoutQuestion(`Context.\n\nNowhere should the gateway read its feature flags from`, "Here should the gateway read its feature flags from?")).toBe(
      "Context.\n\nNowhere should the gateway read its feature flags from",
    );
    expect(withoutQuestion("  Context only.  ", "")).toBe("Context only.");
  });
});

let seq = 0;
const user = (at: number, synthetic = false): TranscriptItem => ({ kind: "user", id: `r${++seq}`, at, text: "do it", images: [], steering: false, synthetic });
const said = (at: number, text: string): TranscriptItem => ({ kind: "assistant", id: `r${++seq}`, at, text, streaming: false });
const thought = (at: number, text: string): TranscriptItem => ({ kind: "thinking", id: `r${++seq}`, at, text, streaming: false, redacted: false });
const tool = (at: number, callId: string, name = "ask"): TranscriptItem => ({ kind: "tool", id: `r${++seq}`, at, callId, tool: name, title: name, args: {}, status: "running", truncated: false });

function rows(...list: TranscriptItem[]): [string[], Record<string, TranscriptItem>] {
  return [list.map((r) => r.id), Object.fromEntries(list.map((r) => [r.id, r]))];
}

describe("contextFromRows", () => {
  test("the text of the message that carries the ask call, never thinking", () => {
    expect(contextFromRows(...rows(user(1), said(5, "Earlier note."), thought(10, "hmm"), said(10, "Config loads once."), tool(10, "c1")), "c1")).toBe("Config loads once.");
    // every text row of that message, around its other calls
    expect(contextFromRows(...rows(user(1), said(10, "Part one."), tool(10, "c0", "read"), said(10, "Part two."), tool(10, "c1")), "c1")).toBe("Part one.\n\nPart two.");
  });

  test("a message with no text: the latest text since the prompt and the rest of its message", () => {
    expect(contextFromRows(...rows(user(1), said(4, "First."), said(5, "Explained."), tool(5, "c0", "read"), said(5, "More."), tool(9, "c1")), "c1")).toBe("Explained.\n\nMore.");
  });

  test("a prompt starts the turn; synthetic user rows don't; error rows without text don't count", () => {
    expect(contextFromRows(...rows(said(1, "Old turn."), user(2), tool(3, "c1")), "c1")).toBe("");
    expect(contextFromRows(...rows(user(1), said(2, "Before the job."), user(3, true), said(4, ""), tool(5, "c1")), "c1")).toBe("Before the job.");
  });

  test("no matching call: the latest text since the prompt", () => {
    expect(contextFromRows(...rows(user(1), said(2, "Older."), said(3, "Newest.")))).toBe("Newest.");
    expect(contextFromRows(...rows(user(1), said(3, "Newest.")), "missing")).toBe("Newest.");
    expect(contextFromRows([], {})).toBe("");
  });

  test("a long text keeps its end, cut at a paragraph", () => {
    const long = `${"a".repeat(CONTEXT_MAX)}\n\nKept paragraph.`;
    expect(contextFromRows(...rows(user(1), said(2, long), tool(2, "c1")), "c1")).toBe("…\n\nKept paragraph.");
  });
});

describe("clipContext", () => {
  test("short text comes back trimmed; long text keeps its end from a paragraph start, led by …", () => {
    expect(clipContext("  short  ")).toBe("short");
    const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"x".repeat(90)}`).join("\n\n");
    const out = clipContext(paras, 1000);
    expect(out.startsWith("…\n\nParagraph ")).toBe(true);
    expect(out.endsWith(`Paragraph 59 ${"x".repeat(90)}`)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1003);
    // one paragraph only: cut at a line, else a word
    expect(clipContext(`${"word ".repeat(400)}end`, 100)).toMatch(/^…\n\n(word )+end$/);
  });

  test("a cut never breaks a code fence, as hosts cut it", () => {
    // Before, the cut took the tail's first blank line: inside a code block it left a lone closing
    // fence (Markdown then showed the code as prose and the rest as code); after a long block, it
    // dropped the block for the last line.
    const code = Array.from({ length: 400 }, (_, i) => `let x${i} = ${i};`).join("\n");
    const out = clipContext(`Here is the patch:\n\n\`\`\`rust\n${code}\n\`\`\`\n\nApply it?`);
    expect(out.startsWith("…\n\n```rust\nlet x")).toBe(true);
    expect(out.split("```").length - 1).toBe(2);
    expect(out.endsWith("```\n\nApply it?")).toBe(true);
    // blank lines inside a code block are no paragraph breaks
    const gapped = Array.from({ length: 300 }, (_, i) => `fn f${i}() {}\n`).join("\n");
    const out2 = clipContext(`Intro.\n\n\`\`\`rust\n${gapped}\`\`\`\n\nOk?`);
    expect(out2.startsWith("…\n\n```rust\n")).toBe(true);
    expect(out2.split("```").length - 1).toBe(2);
    expect(out2.endsWith("Ok?")).toBe(true);
  });
});
