import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { api } from "./lib/api";
import { browserDemoApi } from "./lib/demo-client";

const root = document.getElementById("root");
if (!root) throw new Error("proxbot root element is missing");
const client = "__TAURI_INTERNALS__" in window ? api : browserDemoApi;

createRoot(root).render(<StrictMode><App client={client} /></StrictMode>);
