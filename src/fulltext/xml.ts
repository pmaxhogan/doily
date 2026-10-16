/**
 * A small, tolerant XML tokenizer and tree builder for JATS. JATS from Europe
 * PMC and NCBI efetch is well-formed, so this does not validate; it only has
 * to survive what real files contain: a DOCTYPE (with or without an internal
 * subset), comments, processing instructions (PMC puts dozens inside
 * <graphic>), CDATA, self-closing tags, namespaced names (mml:math,
 * xlink:href) and the occasional stray close tag. No external XML library, so
 * the Worker bundle stays small and there is no DOMParser dependency (workerd
 * has none).
 */

export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: "text";
  text: string;
}

export type XmlNode = XmlElement | XmlText;

/**
 * Named entities beyond the five XML ones that show up in publisher JATS.
 * Written as \u escapes because every source file in this repo is ASCII.
 * Unknown named entities are left verbatim rather than guessed.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bull: "\u2022",
  middot: "\u00b7",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  minus: "\u2212",
  le: "\u2264",
  ge: "\u2265",
  ne: "\u2260",
  asymp: "\u2248",
  deg: "\u00b0",
  micro: "\u00b5",
  prime: "\u2032",
  Prime: "\u2033",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  sect: "\u00a7",
  para: "\u00b6",
  dagger: "\u2020",
  Dagger: "\u2021",
  permil: "\u2030",
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  delta: "\u03b4",
  epsilon: "\u03b5",
  kappa: "\u03ba",
  lambda: "\u03bb",
  mu: "\u03bc",
  pi: "\u03c0",
  sigma: "\u03c3",
  tau: "\u03c4",
  chi: "\u03c7",
  omega: "\u03c9",
  Delta: "\u0394",
  Sigma: "\u03a3",
  Omega: "\u03a9",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1];
    if (!name) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Index just past a DOCTYPE declaration, honoring an internal [subset]. */
function skipDoctype(xml: string, start: number): number {
  let depth = 0;
  for (let i = start; i < xml.length; i++) {
    const c = xml[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  return xml.length;
}

/**
 * Parses `xml` into a synthetic root element named "#document". Unclosed
 * elements are closed at end of input; a close tag with no matching open
 * ancestor is ignored; a close tag that matches an ancestor closes everything
 * in between.
 */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { type: "element", name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = (): XmlElement => stack[stack.length - 1] ?? root;
  const pushText = (raw: string, decode: boolean): void => {
    if (!raw) return;
    const text = decode ? decodeEntities(raw) : raw;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === "text") last.text += text;
    else parent.children.push({ type: "text", text });
  };

  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      pushText(xml.slice(i), true);
      break;
    }
    if (lt > i) pushText(xml.slice(i, lt), true);

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      pushText(xml.slice(lt + 9, end < 0 ? xml.length : end), false);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? xml.length : end + 2;
    } else if (xml.startsWith("<!", lt)) {
      i = skipDoctype(xml, lt + 2);
    } else {
      const gt = findTagEnd(xml, lt + 1);
      const inner = xml.slice(lt + 1, gt);
      i = gt + 1;
      if (inner.startsWith("/")) {
        const name = inner.slice(1).trim();
        const idx = stack.map((e) => e.name).lastIndexOf(name);
        if (idx > 0) stack.length = idx;
      } else {
        const selfClosing = inner.endsWith("/");
        const body = selfClosing ? inner.slice(0, -1) : inner;
        const nameEnd = body.search(/[\s/]/);
        const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
        if (!name) {
          pushText("<", false);
          i = lt + 1;
          continue;
        }
        const el: XmlElement = {
          type: "element",
          name,
          attrs: nameEnd < 0 ? {} : parseAttrs(body.slice(nameEnd)),
          children: [],
        };
        top().children.push(el);
        if (!selfClosing) stack.push(el);
      }
    }
  }
  return root;
}

/** Index of the `>` closing a tag, skipping `>` inside quoted attributes. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return xml.length;
}

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.type === "element" && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) {
    if (c.type === "element" && c.name === name) return c;
  }
  return undefined;
}

/** Depth-first search for the first descendant (or self) named `name`. */
export function findFirst(el: XmlElement, name: string): XmlElement | undefined {
  if (el.name === name) return el;
  for (const c of el.children) {
    if (c.type === "element") {
      const hit = findFirst(c, name);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Concatenated text of every descendant text node. */
export function textContent(node: XmlNode): string {
  if (node.type === "text") return node.text;
  let s = "";
  for (const c of node.children) s += textContent(c);
  return s;
}
