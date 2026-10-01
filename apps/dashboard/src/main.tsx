import "@fontsource/roboto-mono/400.css";
import { createRoot } from "react-dom/client";
import App from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("Dashboard root is missing.");
createRoot(container).render(<App />);
