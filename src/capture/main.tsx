import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/design/styles/index.css";
import { answerFlushRequests } from "@/core/draftFlush";
import { applyInitialMotionAttribute, DesignProvider, startTheme } from "@/design";
import { CaptureWindow } from "@/features/capture/CaptureWindow";

/*
 * The Quick capture window's page (`capture.html`). It never starts the app's core: the main
 * window owns the host connections and the stores, and this page talks to it in messages
 * (`features/capture/link.ts`). Nothing here writes the main window's persisted state.
 */

applyInitialMotionAttribute();
// The main window's theme, read from storage (never written here); follows its changes live.
startTheme({ owner: false });
// The box's own text and images are written out when the shell is about to end the process.
answerFlushRequests();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from capture.html");

createRoot(root).render(
  <StrictMode>
    <DesignProvider>
      <CaptureWindow />
    </DesignProvider>
  </StrictMode>,
);
