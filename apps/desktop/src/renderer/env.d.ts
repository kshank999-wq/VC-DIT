/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

/** The license as the main process reports it (src/main/licensing.ts). */
interface Access {
  plan: 'dit' | 'none';
  state: 'licensed' | 'not-activated' | 'expired-offline' | 'not-configured';
  email: string | null;
  serial: string | null;
  paidThrough: string | null;
  validUntil: string | null;
  message: string | null;
}

/** What the preload exposes (src/preload/index.ts). Absent in a test or a plain browser. */
interface Window {
  vcdit?: {
    platform: string;
    desktop: true;
    license: {
      now: () => Access;
      onChange: (listener: (access: Access) => void) => () => void;
      activate: (code: string) => Promise<Access>;
      refresh: () => Promise<Access>;
      deactivate: () => Promise<Access>;
      open: (page: 'pricing' | 'download' | 'account') => Promise<void>;
    };
  };
}
