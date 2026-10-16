import { describe, expect, it } from "vitest";

import {
  analyzeQuery,
  hasPubMedTags,
  isBooleanQuery,
  tidyBoolean,
  toPlain,
  toS2Bulk,
} from "../../src/search/query.ts";

describe("query dialects", () => {
  it("detects PubMed tags and boolean syntax", () => {
    expect(hasPubMedTags("malaria[mh] AND crispr[tiab]")).toBe(true);
    expect(hasPubMedTags("Smith J[au]")).toBe(true);
    expect(hasPubMedTags("cancer[mesh:noexp]")).toBe(true);
    expect(hasPubMedTags("array[0] access")).toBe(false);
    expect(isBooleanQuery("CRISPR AND malaria")).toBe(true);
    expect(isBooleanQuery('"gene drive"')).toBe(true);
    expect(isBooleanQuery("AUTH:Smith")).toBe(true);
    expect(isBooleanQuery("crispr and malaria")).toBe(false);
  });

  it("free text passes through untouched", () => {
    const q = analyzeQuery("crispr malaria gene drive");
    expect(q).toMatchObject({
      isBoolean: false,
      hasPubMedTags: false,
      europepmc: "crispr malaria gene drive",
      openalex: "crispr malaria gene drive",
      s2Plain: "crispr malaria gene drive",
    });
  });

  it("translates boolean queries per provider", () => {
    const q = analyzeQuery('("gene drive" OR CRISPR) AND malaria NOT mosquito');
    expect(q.europepmc).toBe('("gene drive" OR CRISPR) AND malaria NOT mosquito');
    expect(q.openalex).toBe('("gene drive" OR CRISPR) AND malaria NOT mosquito');
    expect(q.s2Plain).toBe("gene drive CRISPR malaria");
    expect(q.s2Bulk).toBe('("gene drive" | CRISPR) + malaria -mosquito');
  });

  it("strips Europe PMC fields and flags for other providers", () => {
    const q = analyzeQuery('AUTH:"Lukin MD" AND thermometry AND OPEN_ACCESS:y');
    expect(q.europepmc).toBe('AUTH:"Lukin MD" AND thermometry AND OPEN_ACCESS:y');
    expect(q.openalex).toBe('"Lukin MD" AND thermometry');
    expect(q.s2Plain).toBe("Lukin MD thermometry");
    expect(analyzeQuery("SRC:PPR AND covid").openalex).toBe("covid");
  });

  it("strips PubMed tags for non-PubMed providers", () => {
    const q = analyzeQuery("malaria[mh] AND crispr[tiab]");
    expect(q.hasPubMedTags).toBe(true);
    expect(q.pubmed).toBe("malaria[mh] AND crispr[tiab]");
    expect(q.europepmc).toBe("malaria AND crispr");
    expect(q.s2Plain).toBe("malaria crispr");
  });

  it("tidies dangling operators", () => {
    expect(tidyBoolean("AND foo OR")).toBe("foo");
    expect(tidyBoolean("(  ) AND foo")).toBe("foo");
    expect(tidyBoolean("foo AND (OR bar)")).toBe("foo AND (bar)");
    expect(tidyBoolean("foo AND AND bar")).toBe("foo AND bar");
    expect(toPlain("NOT")).toBe("");
    expect(toPlain("-excluded +required well-known")).toBe("excluded required well-known");
    expect(toS2Bulk("a OR b")).toBe("a | b");
  });
});
