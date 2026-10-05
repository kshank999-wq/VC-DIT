/**
 * Makes the Ed25519 key pair that signs desktop entitlements.
 *
 *   npm run keys:license -w @vcdit/web
 *
 * Prints two values and writes nothing to disk:
 *   LICENSE_SIGNING_PRIVATE_KEY — for Vercel (secret; the site signs with it)
 *   MAIN_VITE_LICENSE_PUBLIC_KEY — for the desktop build (public; the app checks with it)
 * Both are base64 of the PEM, one line each, so they paste cleanly. Run it
 * once; making a new pair later signs every installed copy out until it is
 * rebuilt with the new public key.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const line = (pem) => Buffer.from(pem).toString('base64');
console.log(`LICENSE_SIGNING_PRIVATE_KEY=${line(privateKey.export({ type: 'pkcs8', format: 'pem' }))}`);
console.log(`MAIN_VITE_LICENSE_PUBLIC_KEY=${line(publicKey.export({ type: 'spki', format: 'pem' }))}`);
