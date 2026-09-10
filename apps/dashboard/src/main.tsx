import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/roboto-mono/400.css";
import { createRoot } from "react-dom/client";
import App from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("Dashboard root is missing.");
createRoot(container).render(<App />);
