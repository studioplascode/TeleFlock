// Tests for the bridge's 2.7.0 `pinAccount` (docs/bridge-protocol.md "Pin an account"): omp's
// `/session pin` for the main session, and the cases it refuses with a reason.
import { describe, expect, test } from "bun:test";
import { isPinSession, type PinSession, pinSessionAccount } from "./teleflock-bridge";

/** A fake omp AgentSession: two signed-in Anthropic accounts and an API key (credential 4). */
function session(streaming = false): PinSession & { pinned: number[] } {
	const pinned: number[] = [];
	return {
		pinned,
		isStreaming: streaming,
		listCurrentProviderOAuthAccounts: async () => ({
			provider: "anthropic",
			accounts: [
				{ credentialId: 3, label: "dev@example.test", active: true },
				{ credentialId: 5, label: "team@example.test", active: false },
			],
		}),
		pinCurrentProviderOAuthAccount: (id: number) => {
			pinned.push(id);
			return true;
		},
		modelRegistry: { authStorage: { credentials: { list: () => [{ id: 3, credential: { type: "oauth" } }, { id: 4, credential: { type: "api_key" } }, { id: 5, credential: { type: "oauth" } }] } } },
	};
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
	try {
		await p;
	} catch (err) {
		const e = err as { code: string; message: string };
		return { code: e.code, message: e.message };
	}
	throw new Error("expected a refusal");
}

describe("pinAccount", () => {
	test("pins a signed-in account of the session's provider and names it", async () => {
		const s = session();
		expect(isPinSession(s)).toBe(true);
		expect(await pinSessionAccount(s, 5)).toEqual({ provider: "anthropic", label: "team@example.test" });
		expect(s.pinned).toEqual([5]);
	});

	test("refuses while the session streams", async () => {
		const s = session(true);
		expect(await refusal(pinSessionAccount(s, 5))).toEqual({ code: "busy", message: expect.stringContaining("streaming") });
		expect(s.pinned).toEqual([]);
	});

	test("refuses an API key and another provider's credential, saying which", async () => {
		const s = session();
		expect(await refusal(pinSessionAccount(s, 4))).toEqual({ code: "invalid_params", message: expect.stringContaining("API key") });
		expect(await refusal(pinSessionAccount(s, 9))).toEqual({ code: "invalid_params", message: expect.stringContaining("not a signed-in anthropic account") });
		expect(s.pinned).toEqual([]);
	});

	test("refuses when omp does not pin it, and an omp without the API", async () => {
		const s = { ...session(), pinCurrentProviderOAuthAccount: () => false };
		expect(await refusal(pinSessionAccount(s, 3))).toEqual({ code: "unavailable", message: expect.any(String) });
		expect(isPinSession({ retry: () => true })).toBe(false);
	});
});
