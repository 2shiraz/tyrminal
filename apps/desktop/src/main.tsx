import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, ErrorBoundary } from "./app/App";
import { DetachedApp, isDetachedWindow } from "./features/layouts/DetachedWindow"; // agent C: workspaces
import { installInputModality } from "./lib/inputModality";
import { installPressFeedback } from "./lib/press";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

installInputModality();
installPressFeedback();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      {isDetachedWindow() ? <DetachedApp /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
