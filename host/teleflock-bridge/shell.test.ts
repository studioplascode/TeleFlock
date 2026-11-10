// Tests for the bridge's 2.5.0 quick commands (`caps.shell`, docs/bridge-protocol.md "Bridge 2.5.0"):
// which lines omp's TUI runs as `!` / `!!` shell commands or `$` / `$$` Python, and the tap that sends
// every run omp records to hostd.
import { describe, expect, test } from "bun:test";
import { installUserRunTap, quickCommand } from "./teleflock-bridge";

type Json = Record<string, unknown>;

describe("quick commands (omp's input-controller rules)", () => {
	test("! and !! run shell commands, $ and $$ Python; anything else is a message", () => {
		expect(quickCommand("!ls -la")).toEqual({ kind: "bash", excluded: false, code: "ls -la" });
		expect(quickCommand("  !! git status \n")).toEqual({ kind: "bash", excluded: true, code: "git status" });
		expect(quickCommand("!echo a\necho b")).toEqual({ kind: "bash", excluded: false, code: "echo a\necho b" });
		expect(quickCommand("$ print(1)")).toEqual({ kind: "python", excluded: false, code: "print(1)" });
		expect(quickCommand("$$\tx = 1")).toEqual({ kind: "python", excluded: true, code: "x = 1" });
		// A `$` line that reads as a shell command goes to the model, `$$` never does.
		for (const line of ["$ git status", "$ ./run.sh", "$ cat a | wc -l", "$ make 2>&1"]) expect(quickCommand(line)).toBeUndefined();
		expect(quickCommand("$$ git status")).toEqual({ kind: "python", excluded: true, code: "git status" });
		for (const line of ["!", "!! ", "$", "$$", "$ ", "$x = 1", "$$x", "hello !ls", "/model"]) expect(quickCommand(line)).toBeUndefined();
	});
});

describe("the user's runs reach hostd (installUserRunTap)", () => {
	function sessionClass() {
		return class Session {
			calls: Array<{ command: unknown; options: unknown }> = [];
			executeBash(command: string, _onChunk?: unknown, options?: { onRecorded?: (m: unknown) => void }): Promise<Json> {
				this.calls.push({ command, options });
				options?.onRecorded?.({ role: "bashExecution", command, output: "ok\n", exitCode: 0, timestamp: 7 });
				return Promise.resolve({ output: "ok\n", exitCode: 0 });
			}
			executePython(code: string, _onChunk?: unknown, options?: { onRecorded?: (m: unknown) => void; excludeFromContext?: boolean }): Promise<Json> {
				options?.onRecorded?.({ role: "pythonExecution", code, output: "", timestamp: 8, excludeFromContext: options.excludeFromContext });
				return Promise.resolve({ output: "" });
			}
		};
	}

	test("omp's own onRecorded runs first, then hostd hears the message with its session; options pass through; one tap per process", async () => {
		const Session = sessionClass();
		const heard: Array<[Json, unknown]> = [];
		expect(installUserRunTap(Session.prototype, (m, s) => heard.push([m, s]))).toBe(true);
		expect(installUserRunTap(Session.prototype, () => heard.push([{ twice: true }, null]))).toBe(true);
		const s = new Session();
		const own: unknown[] = [];
		const result = await s.executeBash("ls", undefined, { onRecorded: m => own.push(m), useUserShell: true } as never);
		expect(result).toEqual({ output: "ok\n", exitCode: 0 });
		expect(own).toEqual([{ role: "bashExecution", command: "ls", output: "ok\n", exitCode: 0, timestamp: 7 }]);
		expect(heard).toEqual([[{ role: "bashExecution", command: "ls", output: "ok\n", exitCode: 0, timestamp: 7 }, s]]);
		expect(s.calls[0]!.options).toMatchObject({ useUserShell: true });
		await s.executePython("x = 1", undefined, { excludeFromContext: true });
		expect(heard[1]).toEqual([{ role: "pythonExecution", code: "x = 1", output: "", timestamp: 8, excludeFromContext: true }, s]);
	});

	test("a failing report never reaches omp; omp's own failing callback stays omp's", async () => {
		const Session = sessionClass();
		installUserRunTap(Session.prototype, () => {
			throw new Error("hostd side");
		});
		const s = new Session();
		expect(await s.executeBash("ls")).toEqual({ output: "ok\n", exitCode: 0 });
		expect(() =>
			s.executeBash("ls", undefined, {
				onRecorded: () => {
					throw new Error("omp side");
				},
			}),
		).toThrow("omp side");
	});
});
