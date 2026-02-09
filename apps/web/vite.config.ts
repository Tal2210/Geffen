import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // Changed to 5174
    hmr: {
      port: 5174 // Explicitly set HMR port
    }
  }
});
