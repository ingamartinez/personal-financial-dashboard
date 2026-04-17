import { describe, expect, it } from "vitest";
import { fetchTrm } from "./trm";

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
    const fake = mockFetch([
      { valor: "abc", vigenciadesde: "2026-04-17T00:00:00.000" },
    ]);
    await expect(fetchTrm(fake)).rejects.toThrow(/invalid valor/i);
  });

  it("throws on non-2xx response", async () => {
    const fake = mockFetch({}, false, 503);
    await expect(fetchTrm(fake)).rejects.toThrow(/TRM API error 503/);
  });
});
