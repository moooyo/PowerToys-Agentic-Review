import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 8000, strictPort: true },
  preview: { host: "127.0.0.1", port: 8000, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
