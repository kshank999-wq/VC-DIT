import { z } from 'zod';

/** What the desktop app sends about the computer it runs on. */
export const deviceSchema = z.object({
  fingerprint: z.string().min(16).max(200),
  deviceName: z.string().max(120).default(''),
  platform: z.enum(['windows', 'macos']),
  appVersion: z.string().max(40).default(''),
});
