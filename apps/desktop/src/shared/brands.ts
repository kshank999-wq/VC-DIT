/**
 * Camera makers, as the engine recognises a card's contents and the screens
 * badge it: shared, so a saved workflow can be matched to a card in the main
 * process exactly as the card is labelled on screen.
 */

export type Brand = 'arri' | 'red' | 'sony' | 'blackmagic' | 'canon' | 'panasonic' | 'dji';

export const BRAND_NAME: Record<Brand, string> = {
  arri: 'ARRI',
  red: 'RED',
  sony: 'SONY',
  blackmagic: 'Blackmagic',
  canon: 'Canon',
  panasonic: 'Panasonic',
  dji: 'DJI',
};

/** The camera maker, from what the engine found on the card ("ARRI · ARRIRAW", "VENICE 2 · X-OCN ST"). */
export const brandOf = (detected: string | null | undefined): Brand | null => {
  const text = detected ?? '';
  if (/\barri\b|alexa|amira/i.test(text)) return 'arri';
  if (/\bred\b|r3d|v-raptor|komodo|monstro|helium/i.test(text)) return 'red';
  if (/sony|venice|burano|fx[369]|x-ocn|xavc/i.test(text)) return 'sony';
  if (/blackmagic|braw|ursa|pocket/i.test(text)) return 'blackmagic';
  if (/canon|cinema raw|c[37]0|c[35]00/i.test(text)) return 'canon';
  if (/panasonic|varicam|lumix|\bp2\b/i.test(text)) return 'panasonic';
  if (/\bdji\b|ronin|inspire|mavic/i.test(text)) return 'dji';
  return null;
};
