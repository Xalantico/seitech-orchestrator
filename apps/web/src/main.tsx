import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./index.css";
import "./app.css";

try {
  localStorage.removeItem("workflowBuilderDiagram");
} catch {
  // ignore
}
document.documentElement.dataset.theme = localStorage.getItem("orq.theme") ?? "light";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<StrictMode><App /></StrictMode>);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
