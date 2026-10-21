import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/design/styles/index.css";
import { App } from "@/app/App";
import { startCore, startDraftSweep } from "@/core";
import { applyInitialMotionAttribute } from "@/design";

applyInitialMotionAttribute();
startCore();
startDraftSweep();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
