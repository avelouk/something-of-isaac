/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the stats worker, e.g. https://something-of-isaac-stats.<subdomain>.workers.dev */
  readonly VITE_STATS_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
