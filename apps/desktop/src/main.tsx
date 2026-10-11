import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, ErrorBoundary } from "./app/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
