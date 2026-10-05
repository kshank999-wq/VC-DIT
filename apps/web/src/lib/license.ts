import { randomBytes } from 'node:crypto';

/**
 * Authorization codes, VC Writer's serial format with this product's prefix:
 * `VCDIT-XXXXX-XXXXX-XXXXX-XXXXX` from an alphabet without I, O, 0 or 1, so one
 * can be read over the phone or typed on a cart with gloves on.
 *
 * Unlike Game Studio's serial, the code IS the credential: it downloads the
 * installer and activates a computer without signing in, because a DIT cart is
 * often not a machine anyone reads email on. So it is random enough to guess
 * at (20 characters of 32 = 100 bits), every route that takes one is rate
 * limited, and it is only ever shown to its owner (email, account page). The
 * column is still called `serial` in the database.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 4;
const GROUP_LENGTH = 5;
export const CODE_PREFIX = 'VCDIT';

export const generateSerial = (): string => {
  // 256 is a multiple of 32, so byte % 32 is uniform.
  const bytes = randomBytes(GROUPS * GROUP_LENGTH);
  const characters = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]);
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    groups.push(characters.slice(group * GROUP_LENGTH, (group + 1) * GROUP_LENGTH).join(''));
  }
  return `${CODE_PREFIX}-${groups.join('-')}`;
};

const SERIAL_PATTERN = /^VCDIT(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){4}$/;

/**
 * As typed: any case, spaces or no dashes, the prefix optional. Returns the
 * canonical form, or the trimmed upper-case input when it cannot be one (which
 * then fails `isWellFormedSerial`).
 */
export const normalizeSerial = (serial: string): string => {
  const compact = serial.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = compact.startsWith(CODE_PREFIX) ? compact.slice(CODE_PREFIX.length) : compact;
  if (body.length !== GROUPS * GROUP_LENGTH) return serial.trim().toUpperCase();
  const groups = Array.from({ length: GROUPS }, (_, group) => body.slice(group * GROUP_LENGTH, (group + 1) * GROUP_LENGTH));
  return `${CODE_PREFIX}-${groups.join('-')}`;
};

export const isWellFormedSerial = (serial: string): boolean => SERIAL_PATTERN.test(normalizeSerial(serial));
