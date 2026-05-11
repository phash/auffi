import { bindUI } from "./ui.js";

const backendWsUrl = import.meta.env.VITE_BACKEND_WS ?? "ws://localhost:8080/signal";

bindUI(backendWsUrl);
