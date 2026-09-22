/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DHUMI_API_BASE_URL?: string;
  readonly VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
