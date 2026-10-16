import { describe, expect, it } from "vitest";
import xml from "../../fixtures/fulltext/PMC3123456.xml?raw";
import { jatsToMarkdown } from "../../../src/fulltext/jats.ts";
import { decodeEntities, parseXml, textContent } from "../../../src/fulltext/xml.ts";

// Non-ASCII expectations are written as \u escapes: the repo is ASCII-only.

describe("jatsToMarkdown on PMC3123456", () => {
  const plain = jatsToMarkdown(xml, {});
  const withRefs = jatsToMarkdown(xml, { includeReferences: true });

  it("puts the article title first as an h1", () => {
    expect(plain.title).toBe(
      "The Structural Biology Knowledgebase: a portal to protein structures, sequences, functions, and methods",
    );
    expect(
      plain.markdown.startsWith(
        `# ${plain.title}\n\n## Abstract\n\nThe Protein Structure Initiative\u2019s`,
      ),
    ).toBe(true);
  });

  it("strips front-matter boilerplate", () => {
    expect(plain.markdown).not.toContain("Journal of Structural and Functional Genomics");
    expect(plain.markdown).not.toContain("Gabanyi");
    expect(plain.markdown).not.toContain("1345-711X");
    expect(plain.markdown).not.toContain("image-name");
    expect(plain.markdown).not.toContain("<");
  });

  it("maps section nesting to heading depth", () => {
    expect(plain.markdown).toContain("\n## Introduction\n");
    expect(plain.markdown).toContain("\n## Searching the SBKB\n");
    expect(plain.markdown).toContain(
      "\n### Finding sequence-level or structure-level information about a protein of interest\n",
    );
    expect(plain.markdown).toContain(
      "\n#### Links to information from publicly available biological resources\n",
    );
    expect(plain.sections).toEqual([
      "Abstract",
      "Introduction",
      "Content in the Structural Biology Knowledgebase",
      "Searching the SBKB",
      "Finding sequence-level or structure-level information about a protein of interest",
      "Links to information from publicly available biological resources",
      "Conclusions",
      "Abbreviations",
      "Acknowledgements",
    ]);
  });

  it("keeps citation markers from xrefs as plain text", () => {
    expect(plain.markdown).toContain(
      "through publications [1], the Protein Data Bank (PDB) [2, 3] structure",
    );
    expect(plain.markdown).toContain("TOPSAN and others [10\u201313] is presented");
  });

  it("renders the table as a markdown table with a caption", () => {
    expect(plain.markdown).toContain(
      "**Table 1.** List of web addresses to access the features and underlying portals of the Structural Biology Knowledgebase\n\n" +
        "| SBKB and portal sites | Data | Web address |\n" +
        "| --- | --- | --- |\n" +
        "| Structural Biology Knowledgebase | Query and reporting; editorials and news | http://sbkb.org |\n",
    );
    expect(plain.markdown).toContain(
      "| Community-Nominated Target proposal system | Community requests for protein structures | http://cnt.sbkb.org/CNT |",
    );
    // colspan="1" rowspan="1" everywhere is not a span.
    expect(plain.markdown).not.toContain("[table simplified]");
  });

  it("renders the figure as a bold label plus caption", () => {
    expect(plain.markdown).toContain(
      "**Figure 1.** Example of a structure result summary for (PDB + 3cqw). **a** Search results that contain",
    );
    expect(plain.markdown).toContain(
      "a \u201cpost-it\u201d with biological subjects on it\u2014clicking",
    );
  });

  it("keeps the glossary and a short acknowledgement but not the Open Access boilerplate", () => {
    expect(plain.markdown).toContain(
      "## Abbreviations\n\n- **3D**: Three-dimensional\n- **CGI**: Common Gateway Interface",
    );
    expect(plain.markdown).toContain("## Acknowledgements\n\nThe SBKB is a resource center");
    expect(plain.markdown).not.toContain("Creative Commons");
  });

  it("omits references unless asked", () => {
    expect(plain.markdown).not.toContain("## References");
    expect(plain.markdown).not.toContain("Announcing the worldwide Protein Data Bank");
    expect(withRefs.sections.at(-1)).toBe("References");
  });

  it("renders one numbered line per reference when asked", () => {
    const refs = withRefs.markdown
      .slice(withRefs.markdown.indexOf("## References\n\n") + 15)
      .split("\n");
    expect(refs).toHaveLength(6);
    expect(refs[0]).toBe(
      "1. Smith TL (ed) (2000) Structural Genomics Supplement Issue. Nat Struct Biol 7(11s):927\u2013994",
    );
    expect(refs[1]).toBe(
      "2. Berman HM, Henrick K, Nakamura H (2003). Announcing the worldwide Protein Data Bank. Nat Struct Biol 10(12):980. doi:10.1038/nsb1203-980",
    );
    expect(refs[2]).toBe(
      "3. Berman HM, et al. (2000). The protein data bank. Nucleic Acids Res 28:p235-p242. doi:10.1093/nar/28.1.235",
    );
    expect(refs[4]).toContain("http://sbkb.org/KB/structures.jsp");
  });

  it("emits no non-breaking spaces", () => {
    expect(plain.markdown).not.toContain("\u00a0");
  });
});

describe("jatsToMarkdown on synthetic JATS", () => {
  const wrapArticle = (body: string, back = ""): string =>
    `<?xml version="1.0"?><!DOCTYPE article PUBLIC "-//NLM//DTD JATS//EN" "x.dtd" [ <!ENTITY foo "bar"> ]>` +
    `<pmc-articleset><article><front><article-meta><title-group><article-title>T &amp; <italic>X</italic></article-title></title-group>` +
    `<abstract><sec><title>Background</title><p>Why.</p></sec></abstract></article-meta></front>` +
    `<body>${body}</body><back>${back}</back></article></pmc-articleset>`;

  it("finds the article inside an efetch pmc-articleset and handles structured abstracts", () => {
    const r = jatsToMarkdown(wrapArticle("<p>Hi</p>"));
    expect(r.title).toBe("T & *X*");
    expect(r.markdown).toBe("# T & *X*\n\n## Abstract\n\n### Background\n\nWhy.\n\nHi");
  });

  it("renders inline formatting, sup/sub as plain text, and ext-links", () => {
    const r = jatsToMarkdown(
      wrapArticle(
        `<p>CO<sub>2</sub> and x<sup>2</sup> are <bold>bold</bold>, <italic> spaced </italic>words; ` +
          `see <ext-link xlink:href="https://example.org/a">the site</ext-link> <xref ref-type="bibr" rid="b1">[12]</xref>.</p>`,
      ),
    );
    expect(r.markdown.split("\n\n").at(-1)).toBe(
      "CO2 and x2 are **bold**, *spaced* words; see [the site](https://example.org/a) [12].",
    );
  });

  it("renders ordered and nested lists", () => {
    const r = jatsToMarkdown(
      wrapArticle(
        `<sec><title>Steps</title><list list-type="order"><list-item><p>One</p></list-item>` +
          `<list-item><p>Two</p><list list-type="bullet"><list-item><p>Sub</p></list-item></list></list-item></list></sec>`,
      ),
    );
    expect(r.markdown).toContain("## Steps\n\n1. One\n2. Two\n   - Sub");
  });

  it("degrades spanned tables to a simple grid and says so", () => {
    const r = jatsToMarkdown(
      wrapArticle(
        `<table-wrap><label>Table 2</label><caption><title>Spans</title></caption><table>` +
          `<thead><tr><th>A</th><th colspan="2">B</th></tr></thead>` +
          `<tbody><tr><td rowspan="2">r</td><td>1</td><td>a|b</td></tr><tr><td>2</td><td>3</td></tr></tbody></table>` +
          `<table-wrap-foot><p>Footnote.</p></table-wrap-foot></table-wrap>`,
      ),
    );
    expect(r.markdown).toContain(
      "**Table 2.** Spans.\n\n| A | B |  |\n| --- | --- | --- |\n| r | 1 | a\\|b |\n|  | 2 | 3 |\n\n[table simplified]\n\nFootnote.",
    );
  });

  it("splits block content out of paragraphs and numbers unlabeled figures", () => {
    const r = jatsToMarkdown(
      wrapArticle(
        `<p>Before <fig><caption><p>A cap.</p></caption><graphic xlink:href="x.jpg"/></fig> after</p>`,
      ),
    );
    expect(r.markdown).toContain("Before\n\n**Figure 1.** A cap.\n\nafter");
  });

  it("truncates long acknowledgements and renders mixed back matter", () => {
    const long = "word ".repeat(200);
    const r = jatsToMarkdown(
      wrapArticle(
        "<p>x</p>",
        `<ack><p>${long}</p><p>second</p></ack><fn-group><fn><p>Footnote text</p></fn></fn-group>` +
          `<ref-list><ref id="r1"><element-citation><person-group person-group-type="author">` +
          `<name><surname>A</surname><given-names>B</given-names></name><collab>Group</collab></person-group>` +
          `<article-title>Title</article-title><source>J</source><year>2020</year></element-citation></ref></ref-list>`,
      ),
    );
    const ack = r.markdown.split("## Acknowledgements\n\n")[1] ?? "";
    expect(ack.length).toBeLessThan(520);
    expect(ack.endsWith(" ...")).toBe(true);
    expect(r.markdown).not.toContain("second");
    expect(r.markdown).not.toContain("Footnote text");
    expect(r.markdown).not.toContain("## References");
    const withRefs = jatsToMarkdown(
      wrapArticle(
        "<p>x</p>",
        `<ref-list><ref id="r1"><element-citation><person-group person-group-type="author">` +
          `<name><surname>A</surname><given-names>B</given-names></name><collab>Group</collab></person-group>` +
          `<article-title>Title</article-title><source>J</source><year>2020</year></element-citation></ref></ref-list>`,
      ),
      { includeReferences: true },
    );
    expect(withRefs.markdown.endsWith("## References\n\n1. A B, Group (2020). Title. J.")).toBe(
      true,
    );
  });

  it("returns empty markdown for input with no article content", () => {
    expect(jatsToMarkdown("<error>not found</error>")).toEqual({ markdown: "", sections: [] });
    expect(jatsToMarkdown("")).toEqual({ markdown: "", sections: [] });
  });
});

describe("XML tokenizer and entities", () => {
  it("decodes the XML entities, numeric references and common named ones", () => {
    expect(decodeEntities("&amp; &lt; &gt; &quot; &apos;")).toBe(`& < > " '`);
    expect(decodeEntities("&#65;&#x42;&#x4a;")).toBe("ABJ");
    expect(decodeEntities("&#x1F600;")).toBe("\u{1f600}");
    expect(decodeEntities("&ndash;&mdash;&nbsp;&alpha;&plusmn;")).toBe(
      "\u2013\u2014\u00a0\u03b1\u00b1",
    );
  });

  it("leaves unknown or invalid references alone", () => {
    expect(decodeEntities("&bogus; &#xZZ; &#99999999; & alone")).toBe(
      "&bogus; &#xZZ; &#99999999; & alone",
    );
  });

  it("decodes entities only once", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("survives comments, PIs, CDATA, self-closing and namespaced tags, and stray close tags", () => {
    const doc = parseXml(
      `<!-- c --><a x="1 > 2" y='q'><?pi data?><mml:math><mml:mi>x</mml:mi></mml:math>` +
        `<![CDATA[<raw> & stuff]]><etal/></b> tail &amp; more</a>`,
    );
    const a = doc.children[0];
    expect(a?.type === "element" && a.name).toBe("a");
    if (a?.type !== "element") throw new Error("no element");
    expect(a.attrs).toEqual({ x: "1 > 2", y: "q" });
    expect(textContent(a)).toBe("x<raw> & stuff tail & more");
  });

  it("closes unclosed elements at end of input", () => {
    const doc = parseXml("<a><b>text");
    expect(textContent(doc)).toBe("text");
  });
});
