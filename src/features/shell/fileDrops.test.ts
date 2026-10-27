import { expect, test } from "bun:test";
import { guardStrayFileDrops } from "./fileDrops";

type Listener = (e: DragEvent) => void;

/** A window stand-in that records the guard's listeners. */
function fakeWindow() {
  const listeners = new Map<string, Listener>();
  const target = {
    addEventListener: (type: string, l: Listener) => listeners.set(type, l),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window;
  return { target, listeners, fire: (type: string, e: DragEvent) => listeners.get(type)?.(e) };
}

/** A drag carrying a file or text; `taken` = a drop zone below already called preventDefault. */
function drag(kind: "file" | "string", taken = false) {
  const e = {
    defaultPrevented: taken,
    dataTransfer: { items: [{ kind, type: kind === "file" ? "image/png" : "text/plain" }], dropEffect: "copy" },
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e as typeof e & DragEvent;
}

test("a file dragged outside every drop zone is refused; drop zones and text drags are left alone", () => {
  const w = fakeWindow();
  const stop = guardStrayFileDrops(w.target);

  const stray = drag("file");
  w.fire("dragover", stray);
  expect(stray.defaultPrevented).toBe(true);
  expect(stray.dataTransfer.dropEffect).toBe("none");

  const zone = drag("file", true);
  w.fire("dragover", zone);
  expect(zone.dataTransfer.dropEffect).toBe("copy");

  const text = drag("string");
  w.fire("dragover", text);
  expect(text.defaultPrevented).toBe(false);

  const dropped = drag("file");
  w.fire("drop", dropped);
  expect(dropped.defaultPrevented).toBe(true);

  stop();
  expect(w.listeners.size).toBe(0);
});
