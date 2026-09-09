export const TRM_URL = "https://www.datos.gov.co/resource/32sa-8pi3.json";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TrmResult = {
  rate: number;
  asOf: string;
  source: "trm";
};

type SocrataTrmRow = {
  valor?: string;
  vigenciadesde?: string;
  vigenciahasta?: string;
};

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
}

function parseTrmRow(row: SocrataTrmRow): TrmResult {
  if (!row.valor || !row.vigenciadesde) {
    throw new Error("TRM API returned no rows");
  }
  const rate = Number(row.valor);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`TRM API returned invalid valor: ${row.valor}`);
  }
  return { rate, asOf: row.vigenciadesde.slice(0, 10), source: "trm" };
}

export async function fetchTrm(fetchImpl: typeof fetch = fetch): Promise<TrmResult> {
  const url = `${TRM_URL}?$limit=1&$order=vigenciadesde%20DESC`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`TRM API error ${res.status}`);
  const rows = (await res.json()) as SocrataTrmRow[];
  const row = rows[0];
  if (!row) {
    throw new Error("TRM API returned no rows");
  }
  return parseTrmRow(row);
}

/**
 * Historical SuperFinanciera rows whose coverage overlaps `[fromInclusive, toInclusive]`.
 *
 * TRM is a Bogota covering rate, not one row per calendar day: weekends and
 * holidays reuse the previous published `vigenciadesde`. Persist each published
 * row (unique on asOf = vigenciadesde) and look up with `asOf <= date`.
 */
export async function fetchTrmHistory(
  fromInclusive: string,
  toInclusive: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrmResult[]> {
  assertIsoDate(fromInclusive, "fromInclusive");
  assertIsoDate(toInclusive, "toInclusive");
  if (fromInclusive > toInclusive) {
    throw new Error(`TRM history range inverted: ${fromInclusive} > ${toInclusive}`);
  }

  const params = new URLSearchParams({
    $where: `vigenciadesde <= '${toInclusive}T00:00:00.000' AND vigenciahasta >= '${fromInclusive}T00:00:00.000'`,
    $order: "vigenciadesde ASC",
    $limit: "5000",
  });
  const url = `${TRM_URL}?${params.toString()}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`TRM API error ${res.status}`);
  const rows = (await res.json()) as SocrataTrmRow[];

  const results: TrmResult[] = [];
  for (const row of rows) {
    if (!row.valor || !row.vigenciadesde) continue;
    results.push(parseTrmRow(row));
  }
  return results;
}
