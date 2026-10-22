import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/design/styles/index.css";
import { App } from "@/app/App";
import { startCore, startDraftSweep } from "@/core";
import { applyInitialMotionAttribute } from "@/design";
import { resumeInterruptedNaming } from "@/features/dispatch/store";

applyInitialMotionAttribute();
startCore();
startDraftSweep();
// Dispatch entries a reload caught mid-"Naming…" go out without waiting for Dispatch to be opened.
resumeInterruptedNaming();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
