import { buildSystemPrompt, buildUserPrompt, validateResponse, jsonSchema } from "./prompt.mjs";
import { MODELS, ENDPOINTS } from "./models.mjs";
import fs from "node:fs";
const ds = JSON.parse(fs.readFileSync("./dataset.json", "utf8"));
const SYSTEM = buildSystemPrompt(ds.categories.filter((c) => c.slug !== "adjustments"));
const rows = ds.setB.filter((r) => r.tier === "easy").slice(0, 3);
const UP = buildUserPrompt(
  rows.map((r) => ({
    id: r.id,
    description: r.description,
    amountCents: BigInt(r.amountCents),
    currency: r.currency,
  })),
  [],
);
console.log("system tokens approx:", Math.round(SYSTEM.length / 3.5), "chars", SYSTEM.length);
for (const [prov, ep] of Object.entries(ENDPOINTS)) {
  const spec = MODELS.find((m) => m.provider === prov);
  const body = {
    model: spec.model,
    max_tokens: 1024,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: UP },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "classifications", strict: true, schema: jsonSchema },
    },
  };
  const res = await fetch(ep.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[ep.keyEnv]}`,
    },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  console.log(`\n### ${prov} ${spec.model} -> HTTP ${res.status}`);
  if (!res.ok) {
    console.log(t.slice(0, 500));
    continue;
  }
  const j = JSON.parse(t);
  const c = j.choices[0].message.content;
  console.log("usage:", JSON.stringify(j.usage));
  console.log("content:", c.slice(0, 300));
  try {
    console.log("schema errs:", JSON.stringify(validateResponse(JSON.parse(c))));
  } catch (e) {
    console.log("PARSE FAIL", e.message);
  }
}
