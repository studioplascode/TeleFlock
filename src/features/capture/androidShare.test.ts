import { describe, expect, test } from "bun:test";
import { handleShares, type SharedPayload } from "./androidShare";

const share = (id: string): SharedPayload => ({ id, text: id, images: [] });

describe("Android share inbox", () => {
  test("a share that fails doesn't drop the ones after it", async () => {
    const seen: string[] = [];
    await handleShares([share("a"), share("b"), share("c")], async (s) => {
      if (s.id === "b") throw new Error("no repository");
      seen.push(s.id);
    });
    expect(seen).toEqual(["a", "c"]);
  });
});
