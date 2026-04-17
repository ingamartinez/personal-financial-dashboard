import { db } from "./index";
import { accounts, transactions } from "./schema";
import type { ClassificationMethod, TransactionSource } from "@/lib/types";

type Sample = {
  description: string;
  merchant?: string;
  cents: number;
  source: TransactionSource;
  category?: string;
  method?: ClassificationMethod;
};

const samples: Sample[] = [
  {
    description: "COMPRA EXITO CHIA 12345",
    merchant: "Exito",
    cents: -8540000,
    source: "sms",
    category: "mercado",
    method: "rule",
  },
  {
    description: "RAPPI*BURGER KING",
    merchant: "Rappi",
    cents: -3200000,
    source: "apple_pay",
    category: "delivery",
    method: "rule",
  },
  {
    description: "UBER TRIP HELP.UBER.COM",
    merchant: "Uber",
    cents: -1850000,
    source: "apple_pay",
    category: "uber-didi",
    method: "rule",
  },
  {
    description: "DIDI COL",
    merchant: "Didi",
    cents: -1200000,
    source: "apple_pay",
    category: "uber-didi",
    method: "rule",
  },
  {
    description: "NETFLIX.COM",
    merchant: "Netflix",
    cents: -4490000,
    source: "recurring",
    category: "suscripciones",
    method: "manual",
  },
  {
    description: "SPOTIFY P2C2D3F",
    merchant: "Spotify",
    cents: -1690000,
    source: "recurring",
    category: "suscripciones",
    method: "rule",
  },
  {
    description: "PAGO NOMINA EMPRESA SAS",
    cents: 850000000,
    source: "sms",
    category: "salario",
    method: "manual",
  },
  {
    description: "TRANSFERENCIA NEQUI 30012345",
    cents: -15000000,
    source: "sms",
    category: "transferencias",
    method: "manual",
  },
  {
    description: "EPS SURA APORTE MENSUAL",
    cents: -32000000,
    source: "recurring",
    category: "eps",
    method: "manual",
  },
  {
    description: "TERPEL ESTACION 47",
    merchant: "Terpel",
    cents: -12000000,
    source: "sms",
    category: "gasolina",
    method: "rule",
  },
  {
    description: "FARMATODO 102",
    merchant: "Farmatodo",
    cents: -5670000,
    source: "sms",
    category: "medicamentos",
  },
  {
    description: "CLARO PAGO INTERNET",
    cents: -11900000,
    source: "recurring",
    category: "internet-telecom",
    method: "manual",
  },
  {
    description: "EPM ENERGIA OCT",
    cents: -18500000,
    source: "csv",
    category: "energia",
    method: "manual",
  },
  {
    description: "ACUEDUCTO BOGOTA",
    cents: -7200000,
    source: "csv",
    category: "agua",
    method: "manual",
  },
  {
    description: "GASES DE BOGOTA",
    cents: -4100000,
    source: "csv",
    category: "gas",
    method: "manual",
  },
  {
    description: "AMAZON MX MARKETPL",
    merchant: "Amazon",
    cents: -23400000,
    source: "apple_pay",
    category: "tecnologia",
  },
  {
    description: "MERCADO LIBRE COMPRA",
    merchant: "Mercado Libre",
    cents: -8900000,
    source: "apple_pay",
  },
  {
    description: "ZARA CC ANDINO",
    merchant: "Zara",
    cents: -28900000,
    source: "apple_pay",
    category: "ropa",
    method: "manual",
  },
  {
    description: "CINE COLOMBIA",
    cents: -3500000,
    source: "apple_pay",
    category: "entretenimiento",
    method: "manual",
  },
  {
    description: "RESTAURANTE EL CIELO",
    cents: -18900000,
    source: "apple_pay",
    category: "restaurantes",
    method: "manual",
  },
  {
    description: "JUMBO ALMACEN",
    merchant: "Jumbo",
    cents: -12340000,
    source: "sms",
    category: "mercado",
    method: "rule",
  },
  {
    description: "CARULLA EXPRESS",
    merchant: "Carulla",
    cents: -4560000,
    source: "sms",
    category: "mercado",
    method: "rule",
  },
  {
    description: "D1 TIENDAS",
    merchant: "D1",
    cents: -2100000,
    source: "sms",
    category: "mercado",
    method: "rule",
  },
  {
    description: "PAGO TC BANCOLOMBIA",
    cents: -120000000,
    source: "sms",
    category: "pago-tc",
    method: "manual",
  },
  {
    description: "DAVIVIENDA CDT VENCIMIENTO",
    cents: 250000000,
    source: "manual",
    category: "cdts",
    method: "manual",
  },
  {
    description: "CONSULTA MEDICA SURA",
    cents: -8500000,
    source: "csv",
    category: "salud",
    method: "manual",
  },
  { description: "ESTACIONAMIENTO CC", cents: -800000, source: "apple_pay" },
  {
    description: "PEAJE PALMICHAL",
    cents: -1700000,
    source: "apple_pay",
    category: "transporte",
    method: "manual",
  },
  {
    description: "TRANSMILENIO RECARGA",
    cents: -2000000,
    source: "apple_pay",
    category: "transporte-publico",
    method: "manual",
  },
  {
    description: "STARBUCKS COFFEE",
    merchant: "Starbucks",
    cents: -1450000,
    source: "apple_pay",
    category: "restaurantes",
    method: "manual",
  },
  {
    description: "PAGO PRESTAMO BANCOLOMBIA",
    cents: -95000000,
    source: "recurring",
    category: "pago-prestamo",
    method: "manual",
  },
  { description: "AIRBNB PAYMENT", merchant: "Airbnb", cents: -45000000, source: "apple_pay" },
];

async function main() {
  const accs = await db.select().from(accounts);
  if (accs.length === 0) {
    console.error("No accounts found. Run `bun run db:seed` first.");
    process.exit(1);
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const rows = samples.map((s, i) => {
    const acc = accs[i % accs.length];
    const daysAgo = Math.floor(Math.random() * 60);
    const occurredAt = new Date(now - daysAgo * dayMs - Math.floor(Math.random() * dayMs));
    return {
      accountId: acc.id,
      occurredAt,
      amountCents: BigInt(s.cents),
      currency: acc.currency,
      descriptionRaw: s.description,
      merchant: s.merchant ?? null,
      categorySlug: s.category ?? null,
      classificationMethod: s.method ?? (s.category ? "rule" : "unclassified"),
      classificationConfidence: s.category ? 100 : null,
      source: s.source,
    };
  });

  const inserted = await db.insert(transactions).values(rows).returning({ id: transactions.id });
  console.log(`Inserted ${inserted.length} transactions across ${accs.length} accounts.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
