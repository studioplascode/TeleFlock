import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/design/styles/index.css";
import { App } from "@/app/App";
import { startCore, startDrafts, startDraftSweep } from "@/core";
import { applyInitialMotionAttribute, startTheme } from "@/design";
import { resumeInterruptedNaming } from "@/features/dispatch/store";
import { guardStrayFileDrops } from "@/features/shell/fileDrops";
// Browser recordings attached to composer drafts come back after a restart (before drafts load).
import "@/features/recording/register";

applyInitialMotionAttribute();
// The theme's <style> lands after the app's styles before anything renders (no flash of the default).
startTheme({ owner: true });
startCore();
// This page writes the drafts (Quick capture only reads them) and answers the shell's flush requests.
startDrafts();
startDraftSweep();
// Dispatch entries a reload caught mid-"Naming…" go out without waiting for Dispatch to be opened.
resumeInterruptedNaming();
// A file dropped outside a drop zone never replaces the app (the webview would open it).
guardStrayFileDrops();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
