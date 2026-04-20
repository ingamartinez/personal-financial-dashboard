import { describe, it, expect } from "vitest";
import { compareProjections, hashSmsBody, projectFromRegex, sampleForCanary } from "./canary";
import { parseSmsBancolombia } from "@/lib/ingestion/sms-bancolombia";

describe("sampleForCanary", () => {
  it("is deterministic — same body always returns the same verdict", () => {
    const body = "Bancolombia: Compra de $50,000 en EXITO...";
    const a = sampleForCanary(body);
    const b = sampleForCanary(body);
    const c = sampleForCanary(body);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns roughly 1% across a large corpus of unique bodies", () => {
    let positives = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (sampleForCanary(`msg-${i}`)) positives++;
    }
    // Expected ~50. Allow [20, 100] — catches regression to 0% or 10%+.
    expect(positives).toBeGreaterThan(20);
    expect(positives).toBeLessThan(100);
  });

  it("hashSmsBody returns a stable sha256 hex", () => {
    const h = hashSmsBody("hello");
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(h).toHaveLength(64);
  });
});

describe("projectFromRegex", () => {
  it("projects a real purchase SMS into { amountCents, currency, merchant, occurredOn }", () => {
    const sms =
      "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *2575, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";
    const parsed = parseSmsBancolombia(sms);
    const projection = projectFromRegex(parsed);
    expect(projection.amountCents).toBe("3545000");
    expect(projection.currency).toBe("COP");
    expect(projection.merchant).toBe("DLO*DiDi Food CO Pay");
    expect(projection.occurredOn).toBe("2026-04-15");
  });

  it("returns all-null projection for skip results", () => {
    const parsed = parseSmsBancolombia("Tu clave está lista. Descárgala en la app.");
    const projection = projectFromRegex(parsed);
    expect(projection).toEqual({
      amountCents: null,
      currency: null,
      merchant: null,
      occurredOn: null,
    });
  });
});

describe("compareProjections", () => {
  const base = {
    amountCents: "5000000",
    currency: "COP" as const,
    merchant: "EXITO CHIA",
    occurredOn: "2026-04-15",
  };

  it("agrees when all fields match", () => {
    const { agreement, divergenceFields } = compareProjections(base, { ...base });
    expect(agreement).toBe(true);
    expect(divergenceFields).toEqual([]);
  });

  it("disagrees on amount", () => {
    const { agreement, divergenceFields } = compareProjections(base, {
      ...base,
      amountCents: "9999",
    });
    expect(agreement).toBe(false);
    expect(divergenceFields).toEqual(["amountCents"]);
  });

  it("ignores case + punctuation + whitespace in merchant", () => {
    const { agreement } = compareProjections(base, { ...base, merchant: "  éxito,  chía!  " });
    expect(agreement).toBe(true);
  });

  it("null === null agrees; null vs value disagrees", () => {
    const allNull = { amountCents: null, currency: null, merchant: null, occurredOn: null };
    expect(compareProjections(allNull, allNull).agreement).toBe(true);
    const r = compareProjections(allNull, { ...allNull, merchant: "X" });
    expect(r.agreement).toBe(false);
    expect(r.divergenceFields).toEqual(["merchant"]);
  });

  it("reports multiple divergence fields", () => {
    const { agreement, divergenceFields } = compareProjections(base, {
      ...base,
      currency: "USD",
      occurredOn: "2026-04-16",
    });
    expect(agreement).toBe(false);
    expect(divergenceFields).toEqual(["currency", "occurredOn"]);
  });
});

// NOTE: the former parseProjectionJson + its tests were removed. Response
// parsing is now handled by the SDK via output_config.format (structured
// outputs), which constrains the model server-side — unknown currencies
// and prose-wrapped JSON are impossible at the wire level. The Zod schema
// in canary.ts still guards amount/merchant/date coercion client-side;
// those paths are exercised via shadowParseSms integration tests.
