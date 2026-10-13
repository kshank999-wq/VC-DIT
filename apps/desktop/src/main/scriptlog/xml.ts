/**
 * Just enough XML for structured logs: elements, attributes, text, CDATA
 * and the five standard entities. No DTDs, no external entities, nothing
 * fetched: a log file is data, never instructions.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });

/** Parse a document; throws with the line on malformed input. */
export const parseXml = (source: string): XmlElement => {
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const lineAt = (index: number) => source.slice(0, index).split('\n').length;
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (open < 0) {
      top.text += decode(source.slice(i));
      break;
    }
    if (open > i) top.text += decode(source.slice(i, open));
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open);
      if (end < 0) throw new Error(`Unclosed comment at line ${lineAt(open)}.`);
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open);
      if (end < 0) throw new Error(`Unclosed CDATA at line ${lineAt(open)}.`);
      top.text += source.slice(open + 9, end);
      i = end + 3;
    } else if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      const end = source.indexOf('>', open);
      if (end < 0) throw new Error(`Unclosed declaration at line ${lineAt(open)}.`);
      i = end + 1;
    } else if (source.startsWith('</', open)) {
      const end = source.indexOf('>', open);
      const name = source.slice(open + 2, end).trim();
      if (end < 0 || stack.length < 2 || top.name !== name) throw new Error(`Unexpected </${name}> at line ${lineAt(open)}.`);
      stack.pop();
      i = end + 1;
    } else {
      const match = /^<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(source.slice(open, open + 4096));
      if (!match) throw new Error(`Malformed tag at line ${lineAt(open)}.`);
      const element: XmlElement = { name: match[1]!, attributes: {}, children: [], text: '' };
      for (const attribute of match[2]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        element.attributes[attribute[1]!] = decode(attribute[2] ?? attribute[3] ?? '');
      }
      top.children.push(element);
      if (!match[3]) stack.push(element);
      i = open + match[0].length;
    }
  }
  if (stack.length > 1) throw new Error(`<${stack[stack.length - 1]!.name}> is never closed.`);
  return root;
};
