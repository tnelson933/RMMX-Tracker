import { createRoot } from "react-dom/client";
import App from "./App";
import { listenForAppUpdates } from "./lib/appUpdates";
import "./index.css";

listenForAppUpdates();

createRoot(document.getElementById("root")!).render(<App />);
