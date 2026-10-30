import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/design/styles/index.css";
import { applyInitialMotionAttribute, DesignProvider } from "@/design";
import { CaptureWindow } from "@/features/capture/CaptureWindow";

/*
 * The Quick capture window's page (`capture.html`). It never starts the app's core: the main
 * window owns the host connections and the stores, and this page talks to it in messages
 * (`features/capture/link.ts`). Nothing here writes the main window's persisted state.
 */

applyInitialMotionAttribute();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from capture.html");

createRoot(root).render(
  <StrictMode>
    <DesignProvider>
      <CaptureWindow />
    </DesignProvider>
  </StrictMode>,
);
