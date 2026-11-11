/** Entry point of the v2 viewer client: mount the app into the shell page. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./tailwind.css";

const container = document.getElementById("root");
if (!container) throw new Error("Viewer shell is missing its #root element.");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
