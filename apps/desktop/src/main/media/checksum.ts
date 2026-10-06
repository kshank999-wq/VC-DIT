import { createHash } from 'node:crypto';
import xxhash from 'xxhash-wasm';
import type { ChecksumMethod } from '../../shared/media';

/**
 * The three checksums a production may ask for (spec §4.3), fed chunk by
 * chunk so a file is hashed in the same pass that copies it. Digests are
 * lowercase hex, as ASC MHL writes them.
 */

export interface Hasher {
  update(chunk: Uint8Array): void;
  digest(): string;
}

let xx: Awaited<ReturnType<typeof xxhash>> | null = null;

/** Load the xxHash code once (WebAssembly), before the first xxHash64 hasher. */
export const prepareChecksums = async (): Promise<void> => {
  xx ??= await xxhash();
};

export const createHasher = (method: ChecksumMethod): Hasher => {
  if (method === 'xxHash64') {
    if (!xx) throw new Error('prepareChecksums() first');
    const state = xx.create64();
    return {
      update: (chunk) => void state.update(chunk),
      digest: () => state.digest().toString(16).padStart(16, '0'),
    };
  }
  const hash = createHash(method === 'MD5' ? 'md5' : 'sha1');
  return {
    update: (chunk) => void hash.update(chunk),
    digest: () => hash.digest('hex'),
  };
};

/** The element name ASC MHL v2.0 uses for each method. */
export const MHL_HASH_ELEMENT: Record<ChecksumMethod, string> = { xxHash64: 'xxh64', MD5: 'md5', 'SHA-1': 'sha1' };
