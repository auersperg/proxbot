import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { api } from "./lib/api";

const root = document.getElementById("root");
if (!root) throw new Error("proxbot root element is missing");
createRoot(root).render(<StrictMode><App client={api} /></StrictMode>);
