import { defineConfig } from "vite";

// Production deploys to a GitHub Pages project URL:
// https://<user>.github.io/something-of-isaac/
// Override with VITE_BASE if the repo is renamed or a custom domain is set.
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? (mode === "production" ? "/something-of-isaac/" : "./"),
  build: {
    target: "es2022",
    sourcemap: true,
  },
}));
