import { describe, expect, test } from "bun:test";
import { previewTarget } from "./store";

describe("where a preview shows", () => {
  test("the Android app never frames a page it didn't make: every frame of its page gets the app's IPC", () => {
    // Tunnels, on a phone-sized and a wide layout; anything else too (the plugin refuses non-loopback).
    for (const url of ["http://127.0.0.1:49152/", "http://localhost:3000/app", "https://127.0.0.1:8443/", "http://example.com/"]) {
      expect(previewTarget(url, true, true)).toBe("window");
      expect(previewTarget(url, false, true)).toBe("window");
    }
  });

  test("the app's own documents and the other apps keep the sheet and the browser", () => {
    // A demo host in the Android app: its previews are blob documents the app made.
    expect(previewTarget("blob:http://tauri.localhost/6c1e", true, true)).toBe("sheet");
    // Desktop app, browser, devserver: the sheet on a phone-sized layout, the system browser on a wide one.
    expect(previewTarget("http://127.0.0.1:49152/", true, false)).toBe("sheet");
    expect(previewTarget("http://127.0.0.1:49152/", false, false)).toBe("browser");
  });
});
