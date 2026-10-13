/**
 * Camera clip names, made comparable. Script supervisors write "A015C002",
 * "A015_C002", "a15c2" or "A015 C2"; cameras write files such as
 * A015C002_261005_R1AB.mxf (ARRI, Sony), A015_C002_1005XY_001.R3D (RED),
 * A015_10051425_C002.braw (Blackmagic). All of them come down to one key:
 * camera letter, three-digit roll, C, three-digit clip: "A015C002".
 */

const pad3 = (digits: string) => digits.replace(/^0+(?=\d)/, '').padStart(3, '0');

/** The key in a camera file's name, or null for names no camera convention explains (C0001.MP4). */
export const clipKeyOfFile = (fileName: string): string | null => {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const patterns = [
    /^([A-Z])(\d{3})C(\d{3})/i, // ARRI, Sony VENICE, Canon: A015C002_…
    /^([A-Z])(\d{3})_C(\d{3})/i, // RED: A015_C002_…
    /^([A-Z])(\d{3})_\d{6,8}_C(\d{3})/i, // Blackmagic: A015_10051425_C002
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(stem);
    if (found) return `${found[1]!.toUpperCase()}${pad3(found[2]!)}C${pad3(found[3]!)}`;
  }
  return null;
};

/**
 * A frame of an image sequence (ARRIRAW, CinemaDNG, EXR, DPX): the clip's
 * name before the frame number, and the frame. A sequence frame has a long
 * frame number (six digits or more), or a dot before it as EXR and DPX
 * write ("shot.0001.exr"); stills such as DSC01234.DNG or DJI_0001.DNG are
 * not sequences.
 */
export const sequenceOf = (fileName: string): { stem: string; frame: number; extension: string } | null => {
  const found = /^(.+?)([._-]?)(\d{4,9})\.(ari|dng|exr|dpx|cin)$/i.exec(fileName);
  if (!found) return null;
  const [, stem, separator, digits, extension] = found;
  if (digits!.length < 6 && separator !== '.') return null;
  return { stem: stem!, frame: Number(digits), extension: extension!.toLowerCase() };
};

/** Picture files: movies and camera raw clips, and image sequence frames. */
export const isPictureFile = (fileName: string): boolean =>
  /\.(mxf|mov|mp4|m4v|ari|arx|r3d|braw|crm|mts|m2ts|avi)$/i.test(fileName) || sequenceOf(fileName) !== null;

/**
 * The name a picture file's clip is known by: its camera key (A015C002),
 * else, for a frame of an image sequence, the sequence's name (every frame
 * is one clip), else the file's name without its extension.
 */
export const pictureKey = (fileName: string): string => clipKeyOfFile(fileName) ?? sequenceOf(fileName)?.stem ?? fileName.replace(/\.[^.]+$/, '');

/** The key in what a script supervisor typed, or null when it is not a camera clip name. */
export const clipKeyOfRef = (ref: string): string | null => {
  const found = /^\s*([A-Z])\s*[-_ ]?\s*(\d{1,3})\s*[-_ ]?\s*C\s*[-_ ]?\s*(\d{1,4})\b/i.exec(ref);
  if (!found) return clipKeyOfFile(ref.trim());
  return `${found[1]!.toUpperCase()}${pad3(found[2]!)}C${pad3(found[3]!)}`;
};

/** Camera letter and roll from a roll or reel as logged: "A015", "A15", "a-015". */
export const rollKey = (roll: string): string | null => {
  const found = /^\s*([A-Z])\s*[-_ ]?\s*(\d{1,3})\s*$/i.exec(roll);
  return found ? `${found[1]!.toUpperCase()}${pad3(found[2]!)}` : null;
};

/** Lowercase letters and digits only: how sound file names are compared. */
export const loose = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * The names a sound recorder may have given this take's file, loosely:
 * Sound Devices and Zaxcom name files by scene and take ("14B-04", "14B_T04").
 */
export const soundNamesFor = (scene: string, setup: string, take: string): string[] => {
  const slate = loose(`${scene}${setup}`);
  const number = String(Number(take.replace(/\D/g, '')) || take);
  const padded = number.padStart(2, '0');
  const padded3 = number.padStart(3, '0');
  return [...new Set([number, padded, padded3].flatMap((n) => [`${slate}${n}`, `${slate}t${n}`]))];
};
