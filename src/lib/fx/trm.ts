export const TRM_URL = "https://www.datos.gov.co/resource/32sa-8pi3.json";

export type TrmResult = {
  rate: number;
  asOf: string;
  source: "trm";
};

export async function fetchTrm(fetchImpl: typeof fetch = fetch): Promise<TrmResult> {
  const url = `${TRM_URL}?$limit=1&$order=vigenciadesde%20DESC`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`TRM API error ${res.status}`);
  const rows = (await res.json()) as Array<{ valor?: string; vigenciadesde?: string }>;
  const row = rows[0];
  if (!row?.valor || !row.vigenciadesde) {
    throw new Error("TRM API returned no rows");
  }
  const rate = Number(row.valor);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`TRM API returned invalid valor: ${row.valor}`);
  }
  return { rate, asOf: row.vigenciadesde.slice(0, 10), source: "trm" };
}
