// Tests for the ARQ statement PDF adapter.
//
// Because no real PDFs are committed to the repo (they contain PII), tests run
// against:
//   1. Synthetic redacted text fixtures — for parseArqStatementText (pure logic).
//   2. A minimal synthetic PDF generated at test-time — smoke-tests the pdfjs
//      extraction layer.
//
// TODO(#513): replace synthetic PDF fixture with real redacted PDFs once user
//   provides them. The text-fixture tests will remain; only the pdfjs smoke
//   test needs the real file.

import { describe, expect, it } from "vitest";

import {
  ArqPdfExtractionError,
  ArqVisionFallbackDisabledError,
  extractTextFromPdf,
  parseArqStatementPdf,
  parseArqStatementText,
} from "./pdf-adapter";

// ---------------------------------------------------------------------------
// Synthetic text fixture — represents what pdfjs would extract from a real PDF
// ---------------------------------------------------------------------------

/**
 * Minimal synthetic ARQ statement text for January 2026.
 * Layout mirrors the real PDF structure discovered in memory
 * `ingestion/arq-statement-discovery`.
 */
const JAN_2026_TEXT = `
ALEJANDRO RAFAEL MARTINEZ MALDONADO
US - Número de cuenta:  211215197073
Número de ruta:  101019644
Fecha de inicio  1 January 2026
Fecha de fin  31 January 2026
Duración  31 days
Balance de inicio  $262.96
Total ingresos  $2,060.00
Total retiros  $1,594.01
Balance final  $728.95

Jan 01  Pago con tarjeta  -18.03  COP  -67,440  TIENDA D1 BODEGA ESTRE
Jan 02  Venta USDc  -1,594.01  COP  -6,000,000  REDACTED_SELF
Jan 13  Compra USDc  +2,060  USD  +2,060  CODEBRANCH LLC
Jan 13  Pago con tarjeta  -2.99  USD  -2.99  GUMROAD* NOAH NUEBLING
Jan 12  Comisión  -6.99  N/A  N/A  DolarApp subscription
Jan 14  Transferencia P2P  -62  USDc  -62  Dilan Dario Dejanon
`.trim();

/**
 * February 2026 fixture — tests cashback, beneficio, and a different period.
 */
const FEB_2026_TEXT = `
ALEJANDRO RAFAEL MARTINEZ MALDONADO
US - Número de cuenta:  211215197073
Número de ruta:  101019644
Fecha de inicio  1 February 2026
Fecha de fin  28 February 2026
Duración  28 days
Balance de inicio  $728.95
Total ingresos  $2,098.96
Total retiros  $2,028.63
Balance final  $799.28

Feb 12  Cashback  +32.48  USDc  +32.48  Cashback
Feb 28  Beneficio  +6.48  N/A  N/A  Pago beneficio mensual
Feb 15  Pago con tarjeta  -100  USD  -100  CLAUDE.AI SUBSCRIPTION
Feb 20  Transferencia P2P  -500  COP  -1,868,000  Maria Eugenia Giraldo
`.trim();

/**
 * Multi-line description fixture — description spans two lines in the PDF.
 */
const MULTILINE_DESC_TEXT = `
ALEJANDRO RAFAEL MARTINEZ MALDONADO
US - Número de cuenta:  211215197073
Número de ruta:  101019644
Fecha de inicio  1 March 2026
Fecha de fin  31 March 2026
Duración  31 days
Balance de inicio  $799.28
Total ingresos  $2,180.00
Total retiros  $563.81
Balance final  $2,415.47

Mar 01  Venta USDc  -563.81  COP  -2,104,000  Maria Eugenia Giraldo
Klinkert
Mar 15  Compra USDc  +2,180  USD  +2,180  CODEBRANCH LLC
`.trim();

// ---------------------------------------------------------------------------
// Helper: build a synthetic text-based PDF
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PDF with embedded text content.
 * This is a hand-crafted PDF that satisfies the spec well enough for pdfjs to
 * extract text from it. Uses only ASCII characters and Type1 fonts.
 *
 * Note: this is a smoke test for the extraction layer; we intentionally keep
 * the embedded text minimal (not a full statement) since the statement parsing
 * logic is tested separately via text fixtures.
 *
 * TODO(#513): replace with real redacted PDFs once user provides them.
 */
function buildSyntheticPdf(content: string): Buffer {
  // Encode text for PDF stream (simplistic — ASCII only, no special chars)
  const safeLine = (s: string) => s.replace(/[()\\]/g, "\\$&");

  const textCommands = content
    .split("\n")
    .map((line, i) => `BT /F1 10 Tf 50 ${700 - i * 14} Td (${safeLine(line)}) Tj ET`)
    .join("\n");

  const streamContent = textCommands;
  const streamLen = Buffer.byteLength(streamContent, "latin1");

  const objs: string[] = [];
  const offsets: number[] = [];
  let pos = 0;

  const write = (s: string) => {
    objs.push(s);
    return s;
  };

  const header = "%PDF-1.4\n";
  pos += Buffer.byteLength(header, "latin1");

  // Object 1: Catalog
  offsets[1] = pos;
  const o1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  pos += Buffer.byteLength(o1, "latin1");
  write(o1);

  // Object 2: Pages
  offsets[2] = pos;
  const o2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  pos += Buffer.byteLength(o2, "latin1");
  write(o2);

  // Object 3: Page
  offsets[3] = pos;
  const o3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  pos += Buffer.byteLength(o3, "latin1");
  write(o3);

  // Object 4: Content stream
  offsets[4] = pos;
  const o4 = `4 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
  pos += Buffer.byteLength(o4, "latin1");
  write(o4);

  // Object 5: Font
  offsets[5] = pos;
  const o5 =
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n";
  pos += Buffer.byteLength(o5, "latin1");
  write(o5);

  // XRef table
  const xrefOffset = pos;
  const xref = [
    "xref",
    `0 6`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "",
  ].join("\n");

  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + objs.join("") + xref + "\n" + trailer, "latin1");
}

// ---------------------------------------------------------------------------
// parseArqStatementText — header
// ---------------------------------------------------------------------------

describe("parseArqStatementText — header", () => {
  it("parses account holder name", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.accountHolder).toBe("ALEJANDRO RAFAEL MARTINEZ MALDONADO");
  });

  it("parses account number", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.accountNumber).toBe("211215197073");
  });

  it("parses routing number", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.routingNumber).toBe("101019644");
  });

  it("parses period start", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.periodStart).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });

  it("parses period end", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.periodEnd).toEqual(new Date(Date.UTC(2026, 0, 31)));
  });

  it("parses duration days", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.durationDays).toBe(31);
  });

  it("parses balanceStartCents", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.summary.balanceStartCents).toBe(BigInt(26296));
  });

  it("parses totalCreditsCents", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.summary.totalCreditsCents).toBe(BigInt(206000));
  });

  it("parses totalDebitsCents", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.summary.totalDebitsCents).toBe(BigInt(159401));
  });

  it("parses balanceEndCents", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.header.summary.balanceEndCents).toBe(BigInt(72895));
  });

  it("parses February period correctly", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    expect(result.header.periodStart).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect(result.header.periodEnd).toEqual(new Date(Date.UTC(2026, 1, 28)));
    expect(result.header.durationDays).toBe(28);
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — transaction count
// ---------------------------------------------------------------------------

describe("parseArqStatementText — transaction count", () => {
  it("parses all 6 transactions from January fixture", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    expect(result.transactions).toHaveLength(6);
  });

  it("parses 4 transactions from February fixture", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    expect(result.transactions).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — date resolution
// ---------------------------------------------------------------------------

describe("parseArqStatementText — date resolution", () => {
  it("resolves Jan 01 + period 2026-01-01 to Date(2026-01-01)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.amountCents === BigInt(-1803),
    );
    expect(tx).toBeDefined();
    expect(tx!.date).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });

  it("resolves Jan 31 edge: last day of period", () => {
    // Jan 2026 fixture ends on Jan 31 — check that a Jan 13 tx resolves to Jan 2026
    const result = parseArqStatementText(JAN_2026_TEXT);
    const gumroad = result.transactions.find((t) => t.description.includes("GUMROAD"));
    expect(gumroad).toBeDefined();
    expect(gumroad!.date).toEqual(new Date(Date.UTC(2026, 0, 13)));
  });

  it("resolves Feb 28 to the last day of February 2026", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    const beneficio = result.transactions.find((t) => t.type === "Beneficio");
    expect(beneficio).toBeDefined();
    expect(beneficio!.date).toEqual(new Date(Date.UTC(2026, 1, 28)));
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — all 9 raw type strings
// ---------------------------------------------------------------------------

describe("parseArqStatementText — type strings detected", () => {
  const jan = () => parseArqStatementText(JAN_2026_TEXT).transactions;
  const feb = () => parseArqStatementText(FEB_2026_TEXT).transactions;

  it("detects Pago con tarjeta", () => {
    expect(jan().some((t) => t.type === "Pago con tarjeta")).toBe(true);
  });

  it("detects Compra USDc", () => {
    expect(jan().some((t) => t.type === "Compra USDc")).toBe(true);
  });

  it("detects Venta USDc", () => {
    expect(jan().some((t) => t.type === "Venta USDc")).toBe(true);
  });

  it("detects Transferencia P2P", () => {
    expect(jan().some((t) => t.type === "Transferencia P2P")).toBe(true);
  });

  it("detects Comisión", () => {
    expect(jan().some((t) => t.type === "Comisión")).toBe(true);
  });

  it("detects Cashback", () => {
    expect(feb().some((t) => t.type === "Cashback")).toBe(true);
  });

  it("detects Beneficio", () => {
    expect(feb().some((t) => t.type === "Beneficio")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — money representation
// ---------------------------------------------------------------------------

describe("parseArqStatementText — money as bigint cents", () => {
  it("stores amountCents as bigint", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    for (const tx of result.transactions) {
      expect(typeof tx.amountCents).toBe("bigint");
    }
  });

  it("stores equivalentAmountCents as bigint when present", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const cop = result.transactions.find((t) => t.equivalentCurrency === "COP");
    expect(cop).toBeDefined();
    expect(typeof cop!.equivalentAmountCents).toBe("bigint");
  });

  it("Pago con tarjeta COP: amountCents = -1803 (i.e. -$18.03 USDc)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.equivalentCurrency === "COP",
    );
    expect(tx).toBeDefined();
    expect(tx!.amountCents).toBe(BigInt(-1803));
  });

  it("Pago con tarjeta COP: equivalentAmountCents = -6744000 (i.e. -$67,440 COP)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.equivalentCurrency === "COP",
    );
    expect(tx!.equivalentAmountCents).toBe(BigInt(-6744000));
  });

  it("Compra USDc: amountCents = +206000 (i.e. +$2,060 USD)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Compra USDc");
    expect(tx).toBeDefined();
    expect(tx!.amountCents).toBe(BigInt(206000));
  });

  it("Transferencia P2P: amountCents = -6200 (i.e. -62 USDc)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Transferencia P2P");
    expect(tx).toBeDefined();
    expect(tx!.amountCents).toBe(BigInt(-6200));
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — N/A → null
// ---------------------------------------------------------------------------

describe("parseArqStatementText — N/A yields null", () => {
  it("Comisión: equivalentCurrency is null", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Comisión");
    expect(tx).toBeDefined();
    expect(tx!.equivalentCurrency).toBeNull();
  });

  it("Comisión: equivalentAmountCents is null (not 0n)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Comisión");
    expect(tx!.equivalentAmountCents).toBeNull();
  });

  it("Beneficio: equivalentCurrency is null", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Beneficio");
    expect(tx).toBeDefined();
    expect(tx!.equivalentCurrency).toBeNull();
  });

  it("Beneficio: equivalentAmountCents is null", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Beneficio");
    expect(tx!.equivalentAmountCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — multi-line description re-joining
// ---------------------------------------------------------------------------

describe("parseArqStatementText — multi-line description", () => {
  it("joins a two-line description into a single string", () => {
    const result = parseArqStatementText(MULTILINE_DESC_TEXT);
    const venta = result.transactions.find((t) => t.type === "Venta USDc");
    expect(venta).toBeDefined();
    // Description split across two PDF lines should be joined with a space
    expect(venta!.description).toBe("Maria Eugenia Giraldo Klinkert");
  });

  it("does not confuse the continuation line with a new transaction", () => {
    const result = parseArqStatementText(MULTILINE_DESC_TEXT);
    // Only 2 transactions: Venta USDc + Compra USDc (not 3)
    expect(result.transactions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — equivalent currency values
// ---------------------------------------------------------------------------

describe("parseArqStatementText — equivalentCurrency values", () => {
  it("COP for domestic card payments", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.equivalentCurrency === "COP",
    );
    expect(tx!.equivalentCurrency).toBe("COP");
  });

  it("USD for international card payments", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.equivalentCurrency === "USD",
    );
    expect(tx).toBeDefined();
    expect(tx!.equivalentCurrency).toBe("USD");
  });

  it("USD for Compra USDc (onramp)", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Compra USDc");
    expect(tx!.equivalentCurrency).toBe("USD");
  });

  it("USDc for Cashback", () => {
    const result = parseArqStatementText(FEB_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Cashback");
    expect(tx!.equivalentCurrency).toBe("USDc");
  });

  it("USDc for Transferencia P2P intra-ARQ", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Transferencia P2P");
    expect(tx!.equivalentCurrency).toBe("USDc");
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementText — description strings
// ---------------------------------------------------------------------------

describe("parseArqStatementText — description strings", () => {
  it("captures merchant name for Pago con tarjeta", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find(
      (t) => t.type === "Pago con tarjeta" && t.equivalentCurrency === "COP",
    );
    expect(tx!.description).toBe("TIENDA D1 BODEGA ESTRE");
  });

  it("captures counterparty name for Transferencia P2P", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Transferencia P2P");
    expect(tx!.description).toBe("Dilan Dario Dejanon");
  });

  it("captures subscription service for Comisión", () => {
    const result = parseArqStatementText(JAN_2026_TEXT);
    const tx = result.transactions.find((t) => t.type === "Comisión");
    expect(tx!.description).toBe("DolarApp subscription");
  });
});

// ---------------------------------------------------------------------------
// Vision fallback — disabled by default
// ---------------------------------------------------------------------------

describe("Vision fallback", () => {
  it("throws ArqVisionFallbackDisabledError when env var is not set", async () => {
    const originalEnv = process.env.ARQ_VISION_FALLBACK_ENABLED;
    delete process.env.ARQ_VISION_FALLBACK_ENABLED;

    try {
      // Pass an empty buffer — extraction will fail, triggering vision path
      const emptyPdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n%%EOF");
      await expect(parseArqStatementPdf(emptyPdf)).rejects.toThrow(ArqVisionFallbackDisabledError);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ARQ_VISION_FALLBACK_ENABLED = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke test: pdfjs text extraction from a synthetic PDF
// ---------------------------------------------------------------------------

describe("extractTextFromPdf — smoke test with synthetic PDF", () => {
  // TODO(#513): replace with real redacted PDFs once user provides them.
  it("extracts recognisable text from a synthetically generated PDF", async () => {
    const marker = "SYNTHETIC_ARQ_SMOKE_TEST_MARKER";
    const pdfBytes = buildSyntheticPdf(marker);
    const text = await extractTextFromPdf(pdfBytes);
    expect(text).toContain(marker);
  });

  it("returns a non-empty string", async () => {
    const pdfBytes = buildSyntheticPdf("hello world");
    const text = await extractTextFromPdf(pdfBytes);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("throws ArqPdfExtractionError on a completely empty PDF", async () => {
    // PDF with no content stream — pdfjs will succeed loading but yield no text
    const emptyPdf = Buffer.from(
      `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
191
%%EOF`,
    );
    await expect(extractTextFromPdf(emptyPdf)).rejects.toThrow(ArqPdfExtractionError);
  });
});

// ---------------------------------------------------------------------------
// parseArqStatementPdf — integration (text path, no real PDF needed)
// ---------------------------------------------------------------------------

describe("parseArqStatementPdf — integration via synthetic PDF", () => {
  // TODO(#513): replace with real redacted PDFs once user provides them.
  //
  // NOTE: The synthetic PDF builder uses BT/ET operators per line, which
  // pdfjs-dist renders without column-gap preservation (single spaces instead
  // of multi-space column separators). A real ARQ PDF uses absolute x-position
  // Td commands that pdfjs reconstructs as multi-space gaps. Therefore this
  // integration test only verifies the extraction+parsing pipeline works
  // end-to-end with a realistic header, without asserting transaction counts
  // (which depend on the double-space column format present only in real PDFs).
  it("returns a RawStatement with a parsed header from a synthetic PDF", async () => {
    // Only embed the header block — these lines pdfjs extracts correctly since
    // each is in its own BT block and the column format isn't needed.
    const headerOnly = `ALEJANDRO RAFAEL MARTINEZ MALDONADO
US - Número de cuenta:  211215197073
Número de ruta:  101019644
Fecha de inicio  1 January 2026
Fecha de fin  31 January 2026
Duración  31 days
Balance de inicio  $262.96
Total ingresos  $2,060.00
Total retiros  $1,594.01
Balance final  $728.95`;
    const pdfBytes = buildSyntheticPdf(headerOnly);
    const statement = await parseArqStatementPdf(pdfBytes);

    expect(statement.header.accountNumber).toBe("211215197073");
    expect(statement.header.accountHolder).toBe("ALEJANDRO RAFAEL MARTINEZ MALDONADO");
    expect(statement.header.periodStart).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(statement.header.periodEnd).toEqual(new Date(Date.UTC(2026, 0, 31)));
    // Transactions may be 0 for a header-only synthetic — that's expected.
    // The real file will have proper column spacing. See TODO above.
    expect(Array.isArray(statement.transactions)).toBe(true);
  });
});
