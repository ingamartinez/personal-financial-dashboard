import * as XLSX from "xlsx";
import { createHash } from "node:crypto";

export type ParsedRow = {
  rowIndex: number;
  occurredOn: string;
  description: string;
  reference: string | null;
  amountCents: bigint;
  externalId: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  skipped: { rowIndex: number; reason: string }[];
};

const EXPECTED_HEADERS = ["Fecha", "Descripción", "Referencia", "Valor"] as const;

function isEmptyRef(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === "" || s.toLowerCase() === "null";
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    const mm = String(d.m).padStart(2, "0");
    const dd = String(d.d).padStart(2, "0");
    return `${d.y}-${mm}-${dd}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function toCents(value: unknown): bigint | null {
  if (typeof value === "number" && isFinite(value)) {
    return BigInt(Math.round(value * 100));
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "");
    const normalized = cleaned.replace(",", ".");
    const num = Number(normalized);
    if (!isNaN(num)) return BigInt(Math.round(num * 100));
  }
  return null;
}

function buildExternalId(
  accountId: number,
  occurredOn: string,
  amountCents: bigint,
  description: string,
  reference: string | null,
  positionInDay: number,
): string {
  const ref = reference && !isEmptyRef(reference) ? reference.trim() : "";
  const hash = createHash("sha256")
    .update(
      `${accountId}|${occurredOn}|${amountCents.toString()}|${description.trim()}|${ref}|${positionInDay}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `bcol:${accountId}:${hash}`;
}

export function parseBancolombiaXlsx(
  buffer: ArrayBuffer | Uint8Array | Buffer,
  accountId: number,
): ParseResult {
  const wb = XLSX.read(buffer, { cellDates: true, type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { rows: [], skipped: [{ rowIndex: 0, reason: "No sheet found" }] };
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });

  if (aoa.length === 0) {
    return { rows: [], skipped: [] };
  }

  const headerRow = aoa[0]?.map((h) => String(h ?? "").trim()) ?? [];
  const headerOk = EXPECTED_HEADERS.every((h, i) => headerRow[i] === h);
  if (!headerOk) {
    return {
      rows: [],
      skipped: [
        {
          rowIndex: 0,
          reason: `Unexpected headers: got [${headerRow.join(", ")}], expected [${EXPECTED_HEADERS.join(", ")}]`,
        },
      ],
    };
  }

  const rows: ParsedRow[] = [];
  const skipped: { rowIndex: number; reason: string }[] = [];
  const dayCounters = new Map<string, number>();

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i];
    if (!raw || raw.every((c) => c === null || c === "")) continue;

    const occurredOn = toIsoDate(raw[0]);
    const description = raw[1] != null ? String(raw[1]).trim() : "";
    const reference = isEmptyRef(raw[2]) ? null : String(raw[2]).trim();
    const amountCents = toCents(raw[3]);

    if (!occurredOn) {
      skipped.push({ rowIndex: i, reason: `Invalid date: ${String(raw[0])}` });
      continue;
    }
    if (!description) {
      skipped.push({ rowIndex: i, reason: "Missing description" });
      continue;
    }
    if (amountCents === null || amountCents === BigInt(0)) {
      skipped.push({ rowIndex: i, reason: `Invalid amount: ${String(raw[3])}` });
      continue;
    }

    const dayKey = `${occurredOn}|${amountCents.toString()}|${description}|${reference ?? ""}`;
    const positionInDay = dayCounters.get(dayKey) ?? 0;
    dayCounters.set(dayKey, positionInDay + 1);

    rows.push({
      rowIndex: i,
      occurredOn,
      description,
      reference,
      amountCents,
      externalId: buildExternalId(
        accountId,
        occurredOn,
        amountCents,
        description,
        reference,
        positionInDay,
      ),
    });
  }

  return { rows, skipped };
}
