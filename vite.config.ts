import { defineConfig } from "vite";
import { resolve } from "node:path";

// Production lives at https://somethingofisaac.com/ (GitHub Pages + custom domain);
// the deploy workflow sets VITE_BASE="/". Without it a production build falls back
// to the old project-page path, which only matters for a local `vite preview`.
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === "production" ? "/something-of-isaac/" : "./"),
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        support: resolve(__dirname, "support.html"),
      },
    },
  },
}));
