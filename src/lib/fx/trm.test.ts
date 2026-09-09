import { describe, expect, it } from "vitest";
import { fetchTrm, fetchTrmHistory } from "./trm";

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  const impl = async () =>
    new Response(JSON.stringify(payload), {
      status,
      statusText: ok ? "OK" : "ERR",
    });
  return impl as unknown as typeof fetch;
}

describe("fetchTrm", () => {
  it("parses datos.gov.co response into rate + asOf", async () => {
    const fake = mockFetch([
      { valor: "3615.1", unidad: "COP", vigenciadesde: "2026-04-17T00:00:00.000" },
    ]);
    const result = await fetchTrm(fake);
    expect(result).toEqual({
      rate: 3615.1,
      asOf: "2026-04-17",
      source: "trm",
    });
  });

  it("throws when response is empty array", async () => {
    const fake = mockFetch([]);
    await expect(fetchTrm(fake)).rejects.toThrow(/no rows/i);
  });

  it("throws when valor is not a positive number", async () => {
    const fake = mockFetch([{ valor: "abc", vigenciadesde: "2026-04-17T00:00:00.000" }]);
    await expect(fetchTrm(fake)).rejects.toThrow(/invalid valor/i);
  });

  it("throws on non-2xx response", async () => {
    const fake = mockFetch({}, false, 503);
    await expect(fetchTrm(fake)).rejects.toThrow(/TRM API error 503/);
  });
});

describe("fetchTrmHistory", () => {
  it("parses overlapping covering rates, including a weekend-spanning row", async () => {
    const fake = mockFetch([
      {
        valor: "3757.08",
        vigenciadesde: "2025-12-31T00:00:00.000",
        vigenciahasta: "2026-01-02T00:00:00.000",
      },
      {
        valor: "3663.24",
        vigenciadesde: "2026-01-14T00:00:00.000",
        vigenciahasta: "2026-01-14T00:00:00.000",
      },
    ]);
    const rows = await fetchTrmHistory("2026-01-01", "2026-01-14", fake);
    expect(rows).toEqual([
      { rate: 3757.08, asOf: "2025-12-31", source: "trm" },
      { rate: 3663.24, asOf: "2026-01-14", source: "trm" },
    ]);
  });

  it("returns an empty array when the range has no published rows", async () => {
    const fake = mockFetch([]);
    await expect(fetchTrmHistory("1990-01-01", "1990-01-02", fake)).resolves.toEqual([]);
  });

  it("throws on inverted range", async () => {
    await expect(fetchTrmHistory("2026-02-01", "2026-01-01")).rejects.toThrow(/inverted/);
  });

  it("throws on non-ISO dates so SoQL cannot be injected", async () => {
    await expect(fetchTrmHistory("2026-01-01' OR 1=1--", "2026-01-02")).rejects.toThrow(
      /Invalid fromInclusive/,
    );
  });

  it("throws on non-2xx response", async () => {
    const fake = mockFetch({}, false, 503);
    await expect(fetchTrmHistory("2026-01-01", "2026-01-02", fake)).rejects.toThrow(
      /TRM API error 503/,
    );
  });
});
