import type { KeyObject } from 'node:crypto';
import { privateKeyFrom } from './entitlement';
import { env } from './env';

let cached: KeyObject | null = null;

/** The entitlement signing key, parsed once. */
export const signingKey = (): KeyObject => (cached ??= privateKeyFrom(env.licenseSigningKey));
