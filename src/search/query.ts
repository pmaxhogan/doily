/**
 * Query dialects. The agent writes one query; each provider gets the variant
 * it understands:
 *
 *  - Europe PMC: the query as written (boolean, fielded AUTH:/MESH:, flags
 *    like HAS_FT:y all native); PubMed field tags are stripped.
 *  - OpenAlex: boolean AND/OR/NOT, quotes and parentheses kept; Europe PMC
 *    flags dropped, field prefixes unwrapped, PubMed tags stripped.
 *  - Semantic Scholar /paper/search: plain words only. Operators, quotes,
 *    parentheses and whole NOT clauses are removed.
 *  - Semantic Scholar /paper/search/bulk: AND -> +, OR -> |, NOT -> -,
 *    quotes and parentheses kept.
 *  - PubMed: the query as written (only queried when it carries PubMed tags,
 *    or when the caller asks for pubmed explicitly).
 */

const PUBMED_TAG =
  /\[(?:mh|mesh|mesh terms|majr|mesh major topic|sh|subheading|tiab|title\/abstract|ti|title|ab|abstract|au|author|1au|lastau|fau|full author name|ad|affl|affiliation|pt|publication type|dp|pdat|publication date|edat|la|language|ta|jour|journal|tw|text word|all|all fields|nm|pmid|uid|sb|subset|filter|gr|grant number|ot|ps|ip|vi|pg|si|rn)(?::noexp)?\]/gi;

/** Europe PMC flag terms that have no meaning elsewhere. */
const EPMC_FLAGS =
  /\b(?:HAS_[A-Z_]+|OPEN_ACCESS|IN_EPMC|IN_PMC|SRC|PUB_TYPE|LANG|PUB_YEAR|FIRST_PDATE|P_PDATE|LICENSE|SORT_DATE|CITED)\s*:\s*(?:\[[^\]]*\]|"[^"]*"|\S+)/g;

/** Field prefixes such as AUTH:, MESH:, TITLE:, ABSTRACT:, KW:. */
const FIELD_PREFIX = /\b[A-Z][A-Z_]{1,30}:(?=\S)/g;

export interface QueryAnalysis {
  raw: string;
  isBoolean: boolean;
  hasPubMedTags: boolean;
  europepmc: string;
  openalex: string;
  s2Plain: string;
  s2Bulk: string;
  pubmed: string;
}

export function hasPubMedTags(query: string): boolean {
  PUBMED_TAG.lastIndex = 0;
  return PUBMED_TAG.test(query);
}

export function isBooleanQuery(query: string): boolean {
  return (
    /\b(AND|OR|NOT)\b/.test(query) || /["()]/.test(query) || /\b[A-Z][A-Z_]{1,30}:\S/.test(query)
  );
}

function stripPubMedTags(query: string): string {
  return query.replace(PUBMED_TAG, "");
}

/** Removes operators left dangling after terms were deleted, and empty parens. */
export function tidyBoolean(query: string): string {
  let q = query.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 10; i++) {
    const before = q;
    q = q
      .replace(/\(\s*\)/g, "")
      .replace(/\(\s*(AND|OR)\s+/g, "(")
      .replace(/\s+(AND|OR|NOT)\s*\)/g, ")")
      .replace(/^\s*(AND|OR)\s+/, "")
      .replace(/\s+(AND|OR|NOT)\s*$/, "")
      .replace(/\b(AND|OR)\s+(AND|OR)\b/g, "$2")
      .replace(/\b(AND|OR)\s+NOT\s*$/, "")
      .replace(/^\s*NOT\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (q === before) break;
  }
  return q;
}

function forOpenAlex(query: string): string {
  return tidyBoolean(stripPubMedTags(query).replace(EPMC_FLAGS, "").replace(FIELD_PREFIX, ""));
}

function forEuropePmc(query: string): string {
  return tidyBoolean(stripPubMedTags(query));
}

/** Plain words for S2 relevance search: NOT clauses removed entirely. */
export function toPlain(query: string): string {
  const q = forOpenAlex(query)
    .replace(/\bNOT\s+(?:"[^"]*"|\([^)]*\)|\S+)/g, " ")
    .replace(/\b(AND|OR)\b/g, " ")
    // Leading +/-/| operators on a term go; hyphens inside words stay.
    .replace(/(^|\s)[-+|]+/g, "$1")
    .replace(/["()~*|]/g, " ");
  return q.replace(/\s+/g, " ").trim();
}

/** S2 bulk syntax: + (and), | (or), - (not), quotes and parentheses kept. */
export function toS2Bulk(query: string): string {
  const q = forOpenAlex(query)
    .replace(/\bNOT\s+/g, "-")
    .replace(/\s+OR\s+/g, " | ")
    .replace(/\s+AND\s+/g, " + ");
  return q.replace(/\s+/g, " ").trim();
}

export function analyzeQuery(query: string): QueryAnalysis {
  const raw = query.trim();
  return {
    raw,
    isBoolean: isBooleanQuery(raw),
    hasPubMedTags: hasPubMedTags(raw),
    europepmc: forEuropePmc(raw),
    openalex: forOpenAlex(raw),
    s2Plain: toPlain(raw),
    s2Bulk: toS2Bulk(raw),
    pubmed: raw,
  };
}
