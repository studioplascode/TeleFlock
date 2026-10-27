import { dragHasFiles } from "@/core/clipboardImages";

/**
 * Files dragged over the app outside a drop zone are refused: a no-drop cursor, and nothing happens
 * on release. The desktop webviews run HTML5 drag and drop themselves (Tauri's native drag-drop
 * handler is off, `dragDropEnabled: false`, so the composer, Dispatch and terminal drops get the
 * files), and a file nobody takes would otherwise open in the webview in place of the app. A drop
 * zone accepts by calling `preventDefault()` itself; it sits below `window`, so its handler has run
 * by the time the event bubbles up here. Returns the cleanup.
 */
export function guardStrayFileDrops(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const onDragOver = (e: DragEvent) => {
    if (e.defaultPrevented || !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const onDrop = (e: DragEvent) => {
    if (!e.defaultPrevented && dragHasFiles(e.dataTransfer)) e.preventDefault();
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
