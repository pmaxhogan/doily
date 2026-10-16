/**
 * JATS XML (Europe PMC `/{PMCID}/fullTextXML`, NCBI efetch db=pmc) to
 * agent-readable markdown.
 *
 * Output shape:
 *   # Article title
 *   ## Abstract
 *   ## <body sections>, nested <sec> one level deeper each (capped at ######)
 *   ## <back sections>, Acknowledgements (first paragraph, truncated), glossary
 *   ## Figures and tables (only when the article has a <floats-group>)
 *   ## References (only with includeReferences)
 *
 * Journal boilerplate in <front> (journal-meta, contributors, permissions,
 * keywords, history) is dropped; only the title and abstract are used.
 * Footnote groups and <notes> in <back> are dropped too. Non-breaking spaces
 * are turned into plain spaces; every other character is kept as decoded.
 */

import {
  childElements,
  findFirst,
  firstChild,
  parseXml,
  textContent,
  type XmlElement,
  type XmlNode,
} from "./xml.ts";

export interface JatsOptions {
  includeReferences?: boolean;
}

export interface JatsResult {
  markdown: string;
  title?: string;
  /** Every heading emitted below the title, in document order. */
  sections: string[];
}

const ACK_MAX_CHARS = 500;
const MAX_REF_AUTHORS = 6;

/** Elements whose content is never rendered. */
const SKIP = new Set([
  "object-id",
  "graphic",
  "inline-graphic",
  "media",
  "alt-text",
  "long-desc",
  "fn-group",
  "notes",
  "permissions",
  "kwd-group",
  "counts",
  "custom-meta-group",
  "processing-meta",
  "x",
]);

/** Elements rendered as blocks when they appear inside a paragraph. */
const BLOCK = new Set([
  "sec",
  "p",
  "list",
  "table-wrap",
  "table-wrap-group",
  "fig",
  "fig-group",
  "disp-quote",
  "boxed-text",
  "disp-formula",
  "disp-formula-group",
  "def-list",
  "preformat",
  "statement",
  "supplementary-material",
  "array",
  "speech",
  "verse-group",
  "code",
]);

class Renderer {
  readonly sections: string[] = [];
  private figCounter = 0;
  private tableCounter = 0;

  heading(level: number, text: string): string {
    const t = text.trim();
    this.sections.push(t);
    return `${"#".repeat(Math.min(6, Math.max(2, level)))} ${t}`;
  }

  /** Renders an element's children as markdown blocks. */
  blocks(el: XmlElement, level: number): string[] {
    const out: string[] = [];
    let inlineRun: XmlNode[] = [];
    const flush = (): void => {
      const text = this.inlineNodes(inlineRun);
      if (text) out.push(text);
      inlineRun = [];
    };
    for (const c of el.children) {
      if (c.type === "element" && (BLOCK.has(c.name) || c.name === "title" || c.name === "label")) {
        flush();
        if (c.name === "title" || c.name === "label") continue;
        out.push(...this.block(c, level));
      } else {
        inlineRun.push(c);
      }
    }
    flush();
    return out;
  }

  block(el: XmlElement, level: number): string[] {
    if (SKIP.has(el.name)) return [];
    switch (el.name) {
      case "sec":
        return this.sec(el, level);
      case "p":
        return this.blocks(el, level);
      case "list":
        return [this.list(el, 0)].filter(Boolean);
      case "table-wrap":
        return [this.tableWrap(el)];
      case "fig":
        return [this.fig(el)];
      case "disp-quote":
        return this.blocks(el, level).map((b) => b.replace(/^/gm, "> "));
      case "disp-formula":
      case "statement":
      case "verse-group": {
        const t = collapse(this.inline(el));
        return t ? [t] : [];
      }
      case "def-list":
        return [this.defList(el)].filter(Boolean);
      case "preformat":
      case "code":
        return ["```\n" + textContent(el).replace(/^\n+|\s+$/g, "") + "\n```"];
      case "supplementary-material": {
        const caption = this.caption(el);
        return caption ? [`**Supplementary material.** ${caption}`] : [];
      }
      default:
        return this.blocks(el, level);
    }
  }

  sec(el: XmlElement, level: number): string[] {
    const out: string[] = [];
    const titleEl = firstChild(el, "title");
    const labelEl = firstChild(el, "label");
    const title = titleEl ? this.inline(titleEl) : "";
    const label = labelEl ? collapse(textContent(labelEl)) : "";
    const heading = [label, title].filter(Boolean).join(" ");
    if (heading) out.push(this.heading(level, heading));
    out.push(...this.blocks(el, level + 1));
    return out;
  }

  list(el: XmlElement, indent: number): string {
    const ordered = el.attrs["list-type"] === "order";
    const pad = " ".repeat(indent);
    const lines: string[] = [];
    let n = 0;
    for (const item of childElements(el, "list-item")) {
      n++;
      const marker = ordered ? `${n}. ` : "- ";
      const parts: string[] = [];
      const nested: string[] = [];
      for (const c of item.children) {
        if (c.type === "element" && c.name === "list") {
          nested.push(this.list(c, indent + marker.length));
        } else if (c.type === "element" && c.name === "label") {
          continue;
        } else if (c.type === "element" && c.name === "p") {
          const t = this.blocks(c, 6).join(" ");
          if (t) parts.push(t);
        } else {
          const t = c.type === "text" ? collapse(c.text) : this.inline(c);
          if (t) parts.push(t);
        }
      }
      lines.push(pad + marker + parts.join(" "));
      lines.push(...nested.filter(Boolean));
    }
    return lines.join("\n");
  }

  defList(el: XmlElement): string {
    const lines: string[] = [];
    for (const item of childElements(el, "def-item")) {
      const term = firstChild(item, "term");
      const def = firstChild(item, "def");
      const t = term ? this.inline(term) : "";
      const d = def ? this.blocks(def, 6).join(" ") : "";
      if (t || d) lines.push(`- **${t}**: ${d}`);
    }
    return lines.join("\n");
  }

  /** Caption text: caption title then its paragraphs, flattened to one line. */
  caption(el: XmlElement): string {
    const cap = firstChild(el, "caption");
    if (!cap) return "";
    const parts: string[] = [];
    for (const c of childElements(cap)) {
      const t = c.name === "title" ? this.inline(c) : this.blocks(c, 6).join(" ");
      if (t) parts.push(c.name === "title" && !/[.!?:]$/.test(t) ? `${t}.` : t);
    }
    return parts.join(" ");
  }

  numberedLabel(el: XmlElement, kind: string, counter: number): string {
    const labelEl = firstChild(el, "label");
    const label = labelEl ? collapse(textContent(labelEl)) : "";
    const num = /\d+[A-Za-z]?/.exec(label)?.[0];
    if (num) return `${kind} ${num}.`;
    if (label) return /[.:]$/.test(label) ? label : `${label}.`;
    return `${kind} ${counter}.`;
  }

  fig(el: XmlElement): string {
    this.figCounter++;
    const label = this.numberedLabel(el, "Figure", this.figCounter);
    const caption = this.caption(el);
    return `**${label}**${caption ? ` ${caption}` : ""}`;
  }

  tableWrap(el: XmlElement): string {
    this.tableCounter++;
    const label = this.numberedLabel(el, "Table", this.tableCounter);
    const caption = this.caption(el);
    const out: string[] = [`**${label}**${caption ? ` ${caption}` : ""}`];
    const tables: XmlElement[] = [];
    collectTables(el, tables);
    for (const t of tables) out.push(this.table(t));
    const foot = firstChild(el, "table-wrap-foot");
    if (foot) {
      const ft = this.blocks(foot, 6).join(" ");
      if (ft) out.push(ft);
    }
    return out.filter(Boolean).join("\n\n");
  }

  table(el: XmlElement): string {
    const headRows: XmlElement[] = [];
    const bodyRows: XmlElement[] = [];
    for (const c of childElements(el)) {
      if (c.name === "thead") headRows.push(...childElements(c, "tr"));
      else if (c.name === "tbody" || c.name === "tfoot") bodyRows.push(...childElements(c, "tr"));
      else if (c.name === "tr") bodyRows.push(c);
    }
    let simplified = false;
    const grid = (rows: XmlElement[]): string[][] => {
      const out: string[][] = [];
      // Pending rowspans: column index -> rows still to fill.
      const carry = new Map<number, number>();
      for (const tr of rows) {
        const row: string[] = [];
        const place = (): void => {
          while ((carry.get(row.length) ?? 0) > 0) {
            carry.set(row.length, (carry.get(row.length) ?? 0) - 1);
            row.push("");
          }
        };
        for (const cell of childElements(tr)) {
          if (cell.name !== "td" && cell.name !== "th") continue;
          place();
          const colspan = spanOf(cell.attrs["colspan"]);
          const rowspan = spanOf(cell.attrs["rowspan"]);
          if (colspan > 1 || rowspan > 1) simplified = true;
          const start = row.length;
          row.push(cellText(this.blocks(cell, 6).join(" ")));
          for (let k = 1; k < colspan; k++) row.push("");
          if (rowspan > 1) {
            for (let k = start; k < start + colspan; k++) carry.set(k, rowspan - 1);
          }
        }
        place();
        out.push(row);
      }
      return out;
    };
    const head = grid(headRows);
    const body = grid(bodyRows);
    let header: string[];
    if (head.length > 0) {
      // Several header rows collapse into one, column by column.
      const width = Math.max(...head.map((r) => r.length));
      header = Array.from({ length: width }, (_, i) =>
        head
          .map((r) => r[i] ?? "")
          .filter(Boolean)
          .join(" "),
      );
    } else {
      header = body.shift() ?? [];
    }
    const width = Math.max(header.length, ...body.map((r) => r.length), 1);
    const pad = (r: string[]): string[] => Array.from({ length: width }, (_, i) => r[i] ?? "");
    const line = (r: string[]): string => `| ${pad(r).join(" | ")} |`;
    const lines = [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)];
    if (simplified) lines.push("", "[table simplified]");
    return lines.join("\n");
  }

  inlineNodes(nodes: XmlNode[]): string {
    let s = "";
    for (const n of nodes) s += n.type === "text" ? n.text : this.inlineRaw(n);
    return collapse(s);
  }

  inline(el: XmlElement): string {
    return collapse(this.inlineRaw(el));
  }

  /** Inline rendering without whitespace collapsing, so spacing survives. */
  inlineRaw(el: XmlElement): string {
    if (SKIP.has(el.name)) return "";
    const kids = (): string => {
      let s = "";
      for (const c of el.children) s += c.type === "text" ? c.text : this.inlineRaw(c);
      return s;
    };
    switch (el.name) {
      case "italic":
      case "em":
        return wrap(kids(), "*");
      case "bold":
      case "strong":
        return wrap(kids(), "**");
      case "monospace":
        return wrap(kids(), "`");
      case "break":
        return " ";
      case "ext-link":
      case "uri": {
        const text = collapse(kids());
        const href = el.attrs["xlink:href"] ?? el.attrs["href"] ?? "";
        if (!href || text === href) return text || href;
        if (!text) return href;
        return `[${text}](${href})`;
      }
      case "inline-formula":
      case "alternatives": {
        // Prefer the TeX form when a formula offers alternatives.
        const tex = findFirst(el, "tex-math");
        if (tex) return ` ${collapse(textContent(tex))} `;
        return kids();
      }
      case "tex-math":
        return collapse(textContent(el));
      default:
        // xref, sup, sub, sc, underline, named-content, styled-content, ...:
        // plain text of the content (citation markers like [12] survive).
        return kids();
    }
  }

  ref(ref: XmlElement, index: number): string {
    const labelEl = firstChild(ref, "label");
    const num = labelEl ? (/\d+/.exec(textContent(labelEl))?.[0] ?? String(index)) : String(index);
    const cit =
      firstChild(ref, "element-citation") ??
      firstChild(ref, "nlm-citation") ??
      firstChild(ref, "mixed-citation") ??
      findFirst(ref, "element-citation") ??
      findFirst(ref, "mixed-citation") ??
      ref;
    let text: string;
    if (cit.name === "mixed-citation") {
      text = this.inline(cit);
    } else {
      text = this.structuredCitation(cit);
    }
    return `${num}. ${text}`;
  }

  structuredCitation(cit: XmlElement): string {
    const groups = childElements(cit, "person-group");
    const authorGroup =
      groups.find((g) => (g.attrs["person-group-type"] ?? "author") === "author") ?? groups[0];
    const names: string[] = [];
    let etal = false;
    for (const c of authorGroup ? childElements(authorGroup) : childElements(cit)) {
      if (c.name === "name" || c.name === "string-name") {
        const surname = firstChild(c, "surname");
        const given = firstChild(c, "given-names");
        names.push(
          surname
            ? [collapse(textContent(surname)), given ? collapse(textContent(given)) : ""]
                .filter(Boolean)
                .join(" ")
            : collapse(textContent(c)),
        );
      } else if (c.name === "collab") {
        names.push(collapse(textContent(c)));
      } else if (c.name === "etal") {
        etal = true;
      }
    }
    if (names.length > MAX_REF_AUTHORS) {
      names.length = MAX_REF_AUTHORS;
      etal = true;
    }
    let authors = names.join(", ");
    if (etal) authors = authors ? `${authors}, et al.` : "et al.";
    const field = (name: string): string => {
      const e = firstChild(cit, name);
      return e ? this.inline(e) : "";
    };
    const year = field("year");
    const title = field("article-title") || field("chapter-title") || field("data-title");
    const source = field("source");
    const volume = field("volume");
    const issue = field("issue");
    const fpage = field("fpage");
    const lpage = field("lpage");
    const doi = childElements(cit, "pub-id").find((p) => p.attrs["pub-id-type"] === "doi");

    let where = source;
    if (volume) where += `${where ? " " : ""}${volume}`;
    if (issue) where += `(${issue})`;
    if (fpage)
      where += `${volume || issue ? ":" : where ? " " : ""}${fpage}${lpage ? `-${lpage}` : ""}`;

    const parts: string[] = [];
    if (authors) parts.push(year ? `${authors} (${year}).` : endWithPeriod(authors));
    else if (year) parts.push(`(${year}).`);
    if (title) parts.push(endWithPeriod(title));
    if (where) parts.push(endWithPeriod(where));
    if (doi) parts.push(`doi:${collapse(textContent(doi))}`);
    return parts.join(" ") || this.inline(cit);
  }
}

function collectTables(el: XmlElement, out: XmlElement[]): void {
  for (const c of childElements(el)) {
    if (c.name === "table") out.push(c);
    else if (c.name !== "caption" && c.name !== "table-wrap-foot") collectTables(c, out);
  }
}

function spanOf(v: string | undefined): number {
  const n = v ? parseInt(v, 10) : 1;
  return Number.isFinite(n) && n > 1 ? Math.min(n, 50) : 1;
}

function cellText(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function endWithPeriod(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Wraps inner text in a markdown marker, keeping edge whitespace outside. */
function wrap(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const core = m?.[2] ?? "";
  if (!core) return inner;
  return `${m?.[1] ?? ""}${marker}${core}${marker}${m?.[3] ?? ""}`;
}

/** Collapses whitespace (including non-breaking spaces) to single spaces. */
function collapse(s: string): string {
  return s.replace(/[\s\u00a0]+/g, " ").trim();
}

export function jatsToMarkdown(xml: string, opts: JatsOptions = {}): JatsResult {
  const doc = parseXml(xml);
  const article = findFirst(doc, "article") ?? doc;
  const r = new Renderer();
  const blocks: string[] = [];

  const front = firstChild(article, "front");
  const meta = front ? findFirst(front, "article-meta") : undefined;
  const titleEl = meta ? findFirst(meta, "article-title") : undefined;
  const title = titleEl ? r.inline(titleEl) : undefined;
  if (title) blocks.push(`# ${title}`);

  if (meta) {
    const abstracts = childElements(meta, "abstract");
    const primary = abstracts.filter((a) => !a.attrs["abstract-type"]);
    const chosen = primary.length > 0 ? primary : abstracts.slice(0, 1);
    if (chosen.length > 0) {
      blocks.push(r.heading(2, "Abstract"));
      for (const a of chosen) blocks.push(...r.blocks(a, 3));
    }
  }

  const body = firstChild(article, "body");
  if (body) blocks.push(...r.blocks(body, 2));

  const back = firstChild(article, "back");
  if (back) {
    for (const c of childElements(back)) {
      if (c.name === "ack") {
        const titleText = firstChild(c, "title");
        blocks.push(r.heading(2, titleText ? r.inline(titleText) : "Acknowledgements"));
        const firstP = findFirst(c, "p");
        let t = firstP ? r.blocks(firstP, 6).join(" ") : "";
        if (t.length > ACK_MAX_CHARS) t = `${t.slice(0, ACK_MAX_CHARS).replace(/\s+\S*$/, "")} ...`;
        if (t) blocks.push(t);
      } else if (c.name === "glossary") {
        const titleText = firstChild(c, "title");
        blocks.push(r.heading(2, titleText ? r.inline(titleText) : "Glossary"));
        blocks.push(...r.blocks(c, 3));
      } else if (c.name === "sec" || c.name === "app-group" || c.name === "app") {
        blocks.push(...(c.name === "sec" ? r.sec(c, 2) : r.blocks(c, 2)));
      } else if (c.name === "ref-list" && opts.includeReferences) {
        const refs: XmlElement[] = [];
        collectRefs(c, refs);
        if (refs.length > 0) {
          blocks.push(r.heading(2, "References"));
          blocks.push(refs.map((ref, i) => r.ref(ref, i + 1)).join("\n"));
        }
      }
    }
  }

  const floats = firstChild(article, "floats-group");
  if (floats) {
    const fb = r.blocks(floats, 3);
    if (fb.length > 0) blocks.push(r.heading(2, "Figures and tables"), ...fb);
  }

  const markdown = blocks
    .filter((b) => b.trim())
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title === undefined
    ? { markdown, sections: r.sections }
    : { markdown, title, sections: r.sections };
}

function collectRefs(el: XmlElement, out: XmlElement[]): void {
  for (const c of childElements(el)) {
    if (c.name === "ref") out.push(c);
    else if (c.name === "ref-list") collectRefs(c, out);
  }
}
