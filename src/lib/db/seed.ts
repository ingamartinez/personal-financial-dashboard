import { inArray } from "drizzle-orm";
import { db } from "./index";
import { accounts, categories, classificationRules, users, type AccountMetadata } from "./schema";
import type { AccountType, Currency } from "@/lib/types";

const seedAccounts: Array<{
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  metadata?: AccountMetadata;
}> = [
  {
    name: "Bancolombia Ahorros",
    institution: "Bancolombia",
    type: "savings",
    currency: "COP",
    metadata: { last4s: ["6126", "1802"] },
  },
  {
    name: "ARQ Ahorros",
    institution: "ARQ",
    type: "savings",
    currency: "USD",
    metadata: { last4s: ["7073", "1356"] },
  },
  { name: "Efectivo COP", institution: "Cash", type: "savings", currency: "COP" },
  { name: "Efectivo USD", institution: "Cash", type: "savings", currency: "USD" },
  {
    name: "Bancolombia Visa *2575",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    metadata: { last4s: ["2575"], network: "visa" },
  },
  {
    name: "Bancolombia Mastercard *7291 (COP)",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    metadata: { last4s: ["7291"], network: "mastercard" },
  },
  {
    name: "Bancolombia Mastercard *7291 (USD)",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "USD",
    metadata: { last4s: ["7291"], network: "mastercard" },
  },
];

const seedCategories: Array<{
  slug: string;
  name: string;
  parentSlug?: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}> = [
  { slug: "vivienda", name: "Vivienda", icon: "home", color: "#0ea5e9", sortOrder: 10 },
  { slug: "alimentacion", name: "Alimentación", icon: "utensils", color: "#f97316", sortOrder: 20 },
  { slug: "mercado", name: "Mercado", parentSlug: "alimentacion", icon: "shopping-cart" },
  {
    slug: "restaurantes",
    name: "Restaurantes",
    parentSlug: "alimentacion",
    icon: "utensils-crossed",
  },
  { slug: "delivery", name: "Delivery", parentSlug: "alimentacion", icon: "bike" },
  { slug: "transporte", name: "Transporte", icon: "car", color: "#22c55e", sortOrder: 30 },
  { slug: "uber-didi", name: "Uber/Didi", parentSlug: "transporte", icon: "car-taxi-front" },
  { slug: "gasolina", name: "Gasolina", parentSlug: "transporte", icon: "fuel" },
  { slug: "transporte-publico", name: "Transporte Público", parentSlug: "transporte", icon: "bus" },
  { slug: "salud", name: "Salud", icon: "heart-pulse", color: "#ef4444", sortOrder: 40 },
  { slug: "eps", name: "EPS", parentSlug: "salud", icon: "stethoscope" },
  { slug: "medicamentos", name: "Medicamentos", parentSlug: "salud", icon: "pill" },
  { slug: "educacion", name: "Educación", icon: "graduation-cap", color: "#a855f7", sortOrder: 50 },
  {
    slug: "entretenimiento",
    name: "Entretenimiento",
    icon: "popcorn",
    color: "#ec4899",
    sortOrder: 60,
  },
  {
    slug: "servicios-publicos",
    name: "Servicios Públicos",
    icon: "zap",
    color: "#eab308",
    sortOrder: 70,
  },
  { slug: "energia", name: "Energía", parentSlug: "servicios-publicos" },
  { slug: "agua", name: "Agua", parentSlug: "servicios-publicos" },
  { slug: "gas", name: "Gas", parentSlug: "servicios-publicos" },
  { slug: "internet-telecom", name: "Internet/Telecom", parentSlug: "servicios-publicos" },
  { slug: "seguros", name: "Seguros", icon: "shield", color: "#64748b", sortOrder: 80 },
  {
    slug: "inversiones",
    name: "Inversiones",
    icon: "trending-up",
    color: "#10b981",
    sortOrder: 90,
  },
  { slug: "cdts", name: "CDTs", parentSlug: "inversiones" },
  { slug: "fics", name: "FICs", parentSlug: "inversiones" },
  { slug: "deudas", name: "Deudas", icon: "credit-card", color: "#dc2626", sortOrder: 100 },
  { slug: "pago-tc", name: "Pago Tarjeta de Crédito", parentSlug: "deudas" },
  { slug: "pago-prestamo", name: "Pago Préstamo", parentSlug: "deudas" },
  { slug: "ropa", name: "Ropa", icon: "shirt", color: "#8b5cf6", sortOrder: 110 },
  { slug: "tecnologia", name: "Tecnología", icon: "laptop", color: "#06b6d4", sortOrder: 120 },
  {
    slug: "suscripciones",
    name: "Suscripciones",
    icon: "repeat",
    color: "#f59e0b",
    sortOrder: 130,
  },
  {
    slug: "transferencias",
    name: "Transferencias",
    icon: "arrow-right-left",
    color: "#94a3b8",
    sortOrder: 140,
  },
  { slug: "transferencia-persona", name: "A persona", parentSlug: "transferencias" },
  { slug: "ingresos", name: "Ingresos", icon: "wallet", color: "#16a34a", sortOrder: 150 },
  { slug: "salario", name: "Salario", parentSlug: "ingresos" },
  { slug: "otros", name: "Otros", icon: "ellipsis", color: "#6b7280", sortOrder: 999 },
];

const seedRules: Array<{ pattern: string; categorySlug: string; priority?: number }> = [
  { pattern: "%EXITO%", categorySlug: "mercado", priority: 10 },
  { pattern: "%CARULLA%", categorySlug: "mercado", priority: 10 },
  { pattern: "%JUMBO%", categorySlug: "mercado", priority: 10 },
  { pattern: "%OLIMPICA%", categorySlug: "mercado", priority: 10 },
  { pattern: "%D1 %", categorySlug: "mercado", priority: 10 },
  { pattern: "%TIENDAS D1%", categorySlug: "mercado", priority: 10 },
  { pattern: "%ARA %", categorySlug: "mercado", priority: 10 },
  { pattern: "%MAKRO%", categorySlug: "mercado", priority: 10 },
  { pattern: "%RAPPI%", categorySlug: "delivery", priority: 10 },
  { pattern: "%IFOOD%", categorySlug: "delivery", priority: 10 },
  { pattern: "%DIDI FOOD%", categorySlug: "delivery", priority: 10 },
  { pattern: "%UBER %", categorySlug: "uber-didi", priority: 10 },
  { pattern: "%DIDI%", categorySlug: "uber-didi", priority: 20 },
  { pattern: "%CABIFY%", categorySlug: "uber-didi", priority: 10 },
  { pattern: "%TERPEL%", categorySlug: "gasolina", priority: 10 },
  { pattern: "%PRIMAX%", categorySlug: "gasolina", priority: 10 },
  { pattern: "%TEXACO%", categorySlug: "gasolina", priority: 10 },
  { pattern: "%MOBIL%", categorySlug: "gasolina", priority: 10 },
  { pattern: "%EPM%", categorySlug: "energia", priority: 10 },
  { pattern: "%CODENSA%", categorySlug: "energia", priority: 10 },
  { pattern: "%ENEL%", categorySlug: "energia", priority: 10 },
  { pattern: "%ETB%", categorySlug: "internet-telecom", priority: 10 },
  { pattern: "%CLARO%", categorySlug: "internet-telecom", priority: 10 },
  { pattern: "%TIGO%", categorySlug: "internet-telecom", priority: 10 },
  { pattern: "%MOVISTAR%", categorySlug: "internet-telecom", priority: 10 },
  { pattern: "%NETFLIX%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%SPOTIFY%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%DISNEY%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%APPLE.COM/BILL%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%ICLOUD%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%GOOGLE%STORAGE%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%ANTHROPIC%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%CLAUDE.AI%", categorySlug: "suscripciones", priority: 10 },
  { pattern: "%JETSMAR%", categorySlug: "transporte", priority: 10 },
  { pattern: "%SURA%", categorySlug: "seguros", priority: 10 },
  { pattern: "%COLSANITAS%", categorySlug: "eps", priority: 10 },
  { pattern: "%COMPENSAR%", categorySlug: "eps", priority: 10 },
  { pattern: "%FARMATODO%", categorySlug: "medicamentos", priority: 10 },
  { pattern: "%CRUZ VERDE%", categorySlug: "medicamentos", priority: 10 },
  { pattern: "%LA REBAJA%", categorySlug: "medicamentos", priority: 10 },
  // QR payments carry no merchant signal — the SMS only has an opaque "llave"
  // (phone/account identifier). Route them to `transferencias` so they stop
  // polluting `otros`. A user-mapped counterparty default_category still wins
  // because counterparty inheritance happens before this rule in ingestParsed.
  { pattern: "%Pago QR a llave%", categorySlug: "transferencias", priority: 50 },
];

async function seedBootstrapUser() {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim();
  const name = process.env.BOOTSTRAP_USER_NAME?.trim() || email;
  if (!email) {
    console.log("  BOOTSTRAP_USER_EMAIL not set — skipping bootstrap user");
    return;
  }
  await db
    .insert(users)
    .values({ email, name: name ?? email })
    .onConflictDoNothing({ target: users.email });
  console.log(`  bootstrap user ensured for ${email}`);
}

export async function runSeed() {
  console.log("seeding bootstrap user...");
  await seedBootstrapUser();

  console.log("seeding categories...");
  await db.insert(categories).values(seedCategories).onConflictDoNothing();

  console.log("seeding accounts...");
  const existing = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(
      inArray(
        accounts.name,
        seedAccounts.map((a) => a.name),
      ),
    );
  const existingNames = new Set(existing.map((e) => e.name));
  const toInsert = seedAccounts.filter((a) => !existingNames.has(a.name));
  if (toInsert.length > 0) {
    await db.insert(accounts).values(toInsert);
    console.log(`  inserted ${toInsert.length} new accounts`);
  } else {
    console.log("  all accounts already exist");
  }

  console.log("seeding classification rules...");
  await db.insert(classificationRules).values(seedRules).onConflictDoNothing();

  console.log("done");
}

if (import.meta.main) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
