import { describe, expect, test } from "bun:test";
import { priorityLine } from "./priority";

describe("priorityLine", () => {
  test("names what runs above the agents", () => {
    expect(priorityLine({ raised: ["TeleFlock", "SSH server", "Tailscale"], checkedAt: 1 })).toEqual({
      text: "Kept responsive: TeleFlock, SSH server and Tailscale run above agents",
      note: undefined,
      raised: true,
    });
    expect(priorityLine({ raised: ["TeleFlock"], note: "needs root to raise the SSH server and Tailscale", checkedAt: 1 })).toEqual({
      text: "Kept responsive: TeleFlock runs above agents",
      note: "needs root to raise the SSH server and Tailscale",
      raised: true,
    });
    expect(priorityLine({ raised: ["TeleFlock", "SSH server"], checkedAt: 1 })?.text).toBe("Kept responsive: TeleFlock and SSH server run above agents");
  });

  test("says why when nothing could be raised", () => {
    expect(priorityLine({ raised: [], note: "needs root to raise TeleFlock, the SSH server and Tailscale", checkedAt: 1 })).toEqual({
      text: "Not kept above agents",
      note: "needs root to raise TeleFlock, the SSH server and Tailscale",
      raised: false,
    });
    expect(priorityLine({ raised: [], checkedAt: 1 })?.note).toBe("nothing could be raised");
  });

  test("hosts before 0.9.5 show nothing", () => {
    expect(priorityLine(undefined)).toBeNull();
  });
});
