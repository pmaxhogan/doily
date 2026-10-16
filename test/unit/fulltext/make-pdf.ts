/**
 * Builds a minimal, valid PDF in memory: one Helvetica text block per page,
 * one line per array entry, with a correct xref table. Generated at test time
 * instead of committing a binary fixture (scripts/check-ascii.mjs would read a
 * committed .pdf as text).
 */
export function makePdf(pages: string[][]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const pageCount = pages.length;
  // 1: catalog, 2: pages, 3: font, then per page: page object + content stream.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, i) => {
    const contentId = 5 + i * 2;
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const ops = lines
      .map((line, j) => {
        const escaped = line.replace(/[\\()]/g, (c) => `\\${c}`);
        return `${j === 0 ? "72 720 Td" : "0 -14 Td"} (${escaped}) Tj`;
      })
      .join("\n");
    const stream = `BT\n/F1 12 Tf\n${ops}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(new TextEncoder().encode(out));
}
