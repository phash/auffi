/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_WS?: string;
  readonly VITE_FALLBACK_STUN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
