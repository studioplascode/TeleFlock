import { describe, expect, test } from "bun:test";
import { highlight } from "./highlight";

/** The non-blank tokens of `code` as `kind:text`, after checking that the tokens spell `code` exactly. */
function toks(code: string, lang: string): string[] {
  const tokens = highlight(code, lang);
  expect(tokens.map((t) => t.text).join("")).toBe(code);
  return tokens.filter((t) => t.text.trim()).map((t) => `${t.kind}:${t.text.trim()}`);
}

describe("python", () => {
  test("f-strings: the prefix is part of the string, each field is code, its conversion and format spec keywords", () => {
    expect(toks('print(f"{name!r:>10} has {len(items)} items, {{literal}}")', "python")).toEqual([
      "fn:print", "punc:(", 'str:f"', "kw:{", "plain:name", "kw:!r:>10}", "str:has", "kw:{", "fn:len", "punc:(", "plain:items", "punc:)", "kw:}", 'str:items, {{literal}}"', "punc:)",
    ]);
    // a triple-quoted f-string spans lines; `!=` in a field is an operator, not a conversion
    expect(toks('msg = f"""\n{a != b}\n"""', "python")).toEqual(["plain:msg", "op:=", 'str:f"""', "kw:{", "plain:a", "op:!=", "plain:b", "kw:}", 'str:"""']);
  });

  test("string prefixes: raw, bytes and their mixes are strings; an identifier before a quote is not a prefix", () => {
    expect(toks('x = rb"\\d+" + b\'x\' + rf"{z}\\d" + bu"no"', "python")).toEqual([
      "plain:x", "op:=", 'str:rb"\\d+"', "op:+", "str:b'x'", "op:+", 'str:rf"', "kw:{", "plain:z", "kw:}", 'str:\\d"', "op:+", "plain:bu", 'str:"no"',
    ]);
  });

  test("decorators, self, and a keyword used as a method name", () => {
    const t = toks("@pytest.mark.parametrize(\"n\", [1])\ndef test(self, n):\n    self.items.append(n)\n    m = re.match(p, s)\n    match n:\n        case 1: pass", "python");
    expect(t[0]).toBe("attr:@pytest.mark.parametrize");
    expect(t).toContain("lit:self");
    expect(t).toContain("fn:append");
    // `re.match(…)` is a call; the statement `match n:` is the keyword
    expect(t.slice(t.indexOf("plain:re"), t.indexOf("plain:re") + 3)).toEqual(["plain:re", "punc:.", "fn:match"]);
    expect(t).toContain("kw:match");
  });

  test("a string still being written runs to its line's end", () => {
    // (blanks are plain text, so they join the plain words around them)
    expect(toks('f"{x\ny = 1', "python")).toEqual(['str:f"', "kw:{", "plain:x\ny", "op:=", "num:1"]);
    expect(toks('s = "abc\nt', "python")).toEqual(["plain:s", "op:=", 'str:"abc', "plain:t"]);
  });
});

describe("javascript", () => {
  test("template literals: text as a string, `${…}` as code, nested braces and templates included", () => {
    expect(toks("const s = `a ${fn({ b: 1 })} ${`c ${d}`}`;", "js")).toEqual([
      "kw:const", "plain:s", "op:=", "str:`a", "kw:${", "fn:fn", "punc:({", "plain:b", "op::", "num:1", "punc:})", "kw:}", "kw:${", "str:`c", "kw:${", "plain:d", "kw:}", "str:`", "kw:}", "str:`", "punc:;",
    ]);
  });

  test("regex literals where an expression starts; division after a value", () => {
    expect(toks("const re = /[/\\]]+/g; const half = (a + b) / 2 / c; if (/^x/.test(s)) return s.split(/,\\s*/);", "js")).toEqual([
      "kw:const", "plain:re", "op:=", "str:/[/\\]]+/g", "punc:;",
      "kw:const", "plain:half", "op:=", "punc:(", "plain:a", "op:+", "plain:b", "punc:)", "op:/", "num:2", "op:/", "plain:c", "punc:;",
      "kw:if", "punc:(", "str:/^x/", "punc:.", "fn:test", "punc:(", "plain:s", "punc:))", "kw:return", "plain:s", "punc:.", "fn:split", "punc:(", "str:/,\\s*/", "punc:);",
    ]);
    expect(toks("return /x/.source", "js")).toEqual(["kw:return", "str:/x/", "punc:.", "plain:source"]);
  });

  test("members named like keywords are members; spread is not a member access", () => {
    const t = toks("const v = map.get(key) ?? cache.set(k, v); const o = { get size() { return 1 } }; f(...this.args);", "js");
    expect(t.slice(2, 7)).toEqual(["op:=", "plain:map", "punc:.", "fn:get", "punc:("]);
    expect(t).toContain("fn:set");
    expect(t).toContain("kw:get");
    expect(t).toContain("lit:this");
  });
});

describe("shell", () => {
  test("commands, flags, operators, numbers, and `$(…)` inside a string", () => {
    expect(toks('cd src && git log --oneline -n 5 | grep -v "fix: $(date +%Y)" > out.txt 2>&1', "bash")).toEqual([
      "fn:cd", "plain:src", "op:&&", "fn:git", "plain:log", "attr:--oneline", "attr:-n", "num:5", "op:|", "fn:grep", "attr:-v", 'str:"fix:', "var:$(", "fn:date", "plain:+%Y", "var:)", 'str:"', "op:>", "plain:out.txt", "num:2", "op:>&", "num:1",
    ]);
  });

  test("a comment starts a word; expansions; backticks; assignments before a command", () => {
    expect(toks("echo a#b # note", "bash")).toEqual(["fn:echo", "plain:a#b", "com:# note"]);
    expect(toks('echo "in ${PWD}" `uname -s` $HOME ${#arr[@]}', "bash")).toEqual(["fn:echo", 'str:"in', "var:${PWD}", 'str:"', "var:`", "fn:uname", "attr:-s", "var:`", "var:$HOME", "var:${#arr[@]}"]);
    expect(toks("FOO=1 BAR=$(pwd) bun test --bail; for f in *.ts; do wc -l \"$f\"; done", "bash")).toEqual([
      "var:FOO", "op:=", "num:1", "var:BAR", "op:=", "var:$(", "fn:pwd", "var:)", "fn:bun", "plain:test", "attr:--bail", "op:;", "kw:for", "plain:f", "kw:in", "plain:*.ts", "op:;", "kw:do", "fn:wc", "attr:-l", 'str:"', "var:$f", 'str:"', "op:;", "kw:done",
    ]);
  });

  test("a heredoc's body is a string up to its delimiter; the rest of its line and what follows are shell", () => {
    expect(toks("cat > /tmp/x.py <<'EOF' && python3 /tmp/x.py\nprint(\"hi\")  # kept\nEOF\necho done", "bash")).toEqual([
      "fn:cat", "op:>", "plain:/tmp/x.py", "op:<<", "str:'EOF'", "op:&&", "fn:python3", "plain:/tmp/x.py", 'str:print("hi")  # kept\nEOF', "fn:echo", "plain:done",
    ]);
    // still being written: the body runs to the end
    expect(toks("cat <<EOF\nline", "bash")).toEqual(["fn:cat", "op:<<", "str:EOF\nline"]);
  });
});

describe("robustness", () => {
  test("unclosed and deeply nested code keeps every character and stays shallow", () => {
    for (const [code, lang] of [
      ["`${".repeat(5000), "js"],
      ["f\"{f'{".repeat(3000), "python"],
      ["$(".repeat(5000), "bash"],
      ['"$('.repeat(3000), "bash"],
      ["x <<A ".repeat(3000), "bash"],
      ["a=1 ".repeat(3000) + "cmd", "bash"],
      ["/", "js"],
      ["\\", "bash"],
    ] as const)
      expect(highlight(code, lang).map((t) => t.text).join("")).toBe(code);
  });
});
