// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: teal; icon-glyph: chart-pie;

// ============================================================================
// Findash — Scriptable widget
// ----------------------------------------------------------------------------
// One script, five widgets. The specific widget to render is picked via the
// home-screen widget "Parameter" field. Format:
//
//   <widget_id>.<size>[|<extra>]
//
// Examples:
//   tc-focus.S|3a4b5c6d-...-uuid   → tc-focus tile with a physical_cards id
//   tc-focus.S|42                  → tc-focus tile with an accounts.id
//   mis-tcs.M                      → roster of top-3 credit cards
//   mis-tcs.L                      → full credit-card roster
//   hoy.S                          → today's spending tile
//   mes-actual.M                   → month-to-date spend + projection
//   recent-tx.M                    → last 3 transactions
//   recent-tx.L                    → last 5 transactions
//
// Before first use, run `findash-set-token.js` once to stash your widget token
// and base URL in Keychain. Both are read from the keys:
//   FINDASH_TOKEN     — widget token minted at /settings/widgets
//   FINDASH_BASE_URL  — e.g. https://findash.example.com
//
// The script caches the last-successful payload per parameter in Keychain, so
// a transient network failure still renders yesterday's numbers with a "stale"
// marker instead of going blank.
// ============================================================================

// ----------------------------------------------------------------------------
// Config — adjust if you want a different default preview or refresh cadence.
// ----------------------------------------------------------------------------

const DEFAULT_PREVIEW_PARAM = "hoy.S";
const REFRESH_MINUTES = 30;
const REQUEST_TIMEOUT_SECONDS = 10;

// Findash brand palette (keep in sync with tailwind.config / brand tokens).
const COLOR = {
  primary: new Color("#14b8a6"),
  primaryDim: new Color("#0f766e"),
  danger: new Color("#ef4444"),
  warning: new Color("#f59e0b"),
  success: new Color("#22c55e"),
  muted: new Color("#6b7280"),
  mutedDim: new Color("#9ca3af"),
  text: Color.dynamic(new Color("#111827"), new Color("#f9fafb")),
  subtext: Color.dynamic(new Color("#4b5563"), new Color("#d1d5db")),
  bgCard: Color.dynamic(new Color("#ffffff"), new Color("#111827")),
  barTrack: Color.dynamic(new Color("#e5e7eb"), new Color("#374151")),
};

// ----------------------------------------------------------------------------
// Keychain helpers — silent when the key is missing.
// ----------------------------------------------------------------------------

function keychainGet(key) {
  return Keychain.contains(key) ? Keychain.get(key) : null;
}

function keychainSet(key, value) {
  Keychain.set(key, value);
}

// ----------------------------------------------------------------------------
// Parameter parser. Accepts "<id>.<size>[|<extra>]" with tolerant whitespace.
// Returns { widgetId, size, extra } or throws on malformed input.
// ----------------------------------------------------------------------------

function parseParameter(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("empty-parameter");
  }
  const trimmed = raw.trim();
  const pipeIdx = trimmed.indexOf("|");
  const head = pipeIdx === -1 ? trimmed : trimmed.slice(0, pipeIdx);
  const extra = pipeIdx === -1 ? null : trimmed.slice(pipeIdx + 1).trim();
  const dotIdx = head.lastIndexOf(".");
  if (dotIdx === -1) {
    throw new Error("bad-parameter");
  }
  const widgetId = head.slice(0, dotIdx).trim();
  const size = head
    .slice(dotIdx + 1)
    .trim()
    .toUpperCase();
  if (!widgetId || !["S", "M", "L"].includes(size)) {
    throw new Error("bad-parameter");
  }
  return { widgetId, size, extra: extra || null };
}

// ----------------------------------------------------------------------------
// HTTP client. Bearer-auth GET, JSON decode, mapped errors.
// ----------------------------------------------------------------------------

async function fetchWidget({ baseUrl, token, widgetId, size, extra }) {
  // Scriptable's JavaScriptCore runtime does not expose URLSearchParams, so
  // we build the query string by hand with encodeURIComponent.
  const qs = [`size=${encodeURIComponent(size)}`];
  if (extra && widgetId === "tc-focus") {
    // tc-focus uses `target=<id>`. Today it is the only widget that takes an
    // extra. If new widgets add extras, extend the mapping here.
    qs.push(`target=${encodeURIComponent(extra)}`);
  }
  const url = `${baseUrl.replace(/\/$/, "")}/api/widget/v1/${widgetId}?${qs.join("&")}`;
  const req = new Request(url);
  req.method = "GET";
  req.headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  req.timeoutInterval = REQUEST_TIMEOUT_SECONDS;
  let payload;
  try {
    payload = await req.loadJSON();
  } catch (e) {
    throw new FindashError("network", `No se pudo contactar a Findash: ${e.message}`);
  }
  const status = req.response?.statusCode ?? 0;
  if (status === 401 || status === 403) {
    throw new FindashError("auth", "Token inválido — revisá en /settings/widgets.");
  }
  if (status === 404) {
    const code = payload?.error?.code;
    if (code === "widget_not_found") {
      throw new FindashError("unknown-widget", "Widget desconocido.");
    }
    throw new FindashError("not-found", payload?.error?.message || "No encontrado.");
  }
  if (status === 422) {
    throw new FindashError("invalid", payload?.error?.message || "Parámetros inválidos.");
  }
  if (status === 429) {
    throw new FindashError("rate", "Demasiadas peticiones — intentá en unos minutos.");
  }
  if (status < 200 || status >= 300) {
    throw new FindashError("server", `Error ${status} en Findash.`);
  }
  return payload;
}

class FindashError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ----------------------------------------------------------------------------
// Cache. Per-parameter key in Keychain. Small payloads (< 5 KB) so no need
// for iCloud / FileManager — Keychain is sufficient and survives reboots.
// ----------------------------------------------------------------------------

function cacheKey(parameter) {
  return `FINDASH_CACHE_${parameter}`;
}

function saveCache(parameter, payload) {
  try {
    keychainSet(
      cacheKey(parameter),
      JSON.stringify({ cachedAt: new Date().toISOString(), payload }),
    );
  } catch (_e) {
    // Keychain can reject oversized values; cache is a best-effort nicety.
  }
}

function loadCache(parameter) {
  const raw = keychainGet(cacheKey(parameter));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Money formatting — COP-pesos are the only currency surfaced in widgets.
// ----------------------------------------------------------------------------

function formatCop(value, { compact = false, signed = false } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  const abs = Math.abs(value);
  if (compact) {
    if (abs >= 1_000_000) {
      const m = abs / 1_000_000;
      const digits = m >= 10 ? 0 : 1;
      return `${sign}${value < 0 ? "-" : ""}$${m.toFixed(digits)}M`;
    }
    if (abs >= 1_000) {
      return `${sign}${value < 0 ? "-" : ""}$${Math.round(abs / 1_000)}K`;
    }
    return `${sign}${value < 0 ? "-" : ""}$${abs}`;
  }
  // Long form: $1.234.567
  const withThousands = Math.round(abs)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${value < 0 ? "-" : ""}$${withThousands}`;
}

function utilizationColor(pct) {
  if (pct >= 90) return COLOR.danger;
  if (pct >= 70) return COLOR.warning;
  return COLOR.success;
}

// ----------------------------------------------------------------------------
// Rendering primitives — keep small, composable. All layout uses Stack +
// Text + basic spacers.
// ----------------------------------------------------------------------------

function setCommonBackground(widget) {
  widget.backgroundColor = COLOR.bgCard;
  widget.setPadding(10, 12, 10, 12);
}

function addHeaderText(stack, text, { size = 10, color = COLOR.muted, bold = false } = {}) {
  const t = stack.addText(text);
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}

function addAmountText(stack, text, { size = 24, color = COLOR.text } = {}) {
  const t = stack.addText(text);
  t.font = Font.boldSystemFont(size);
  t.textColor = color;
  t.minimumScaleFactor = 0.6;
  t.lineLimit = 1;
  return t;
}

/**
 * Draws a utilization bar as a sequence of colored squares into `stack`.
 * Keeps things ListWidget-safe — we don't need DrawContext / WebView.
 */
function addUtilizationBar(stack, pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const track = stack.addStack();
  track.layoutHorizontally();
  track.spacing = 2;
  track.cornerRadius = 3;
  const totalSegments = 10;
  const filledSegments = Math.round(clamped / 10);
  for (let i = 0; i < totalSegments; i += 1) {
    const seg = track.addStack();
    seg.size = new Size(10, 6);
    seg.cornerRadius = 2;
    seg.backgroundColor = i < filledSegments ? utilizationColor(clamped) : COLOR.barTrack;
  }
}

function addStaleFooter(widget) {
  const footer = widget.addStack();
  footer.layoutHorizontally();
  footer.addSpacer();
  const t = footer.addText("• datos en caché");
  t.font = Font.systemFont(9);
  t.textColor = COLOR.warning;
}

// ----------------------------------------------------------------------------
// Per-widget renderers. Each takes the `data` shape returned by the handler
// and populates a ListWidget. They accept an opts object carrying layout
// hints (size, stale flag).
// ----------------------------------------------------------------------------

function renderTcFocus(widget, data, { stale }) {
  setCommonBackground(widget);
  const name = data.card_name || "Tarjeta";
  addHeaderText(widget, name, { size: 11, color: COLOR.subtext, bold: true });
  widget.addSpacer(2);
  addAmountText(widget, formatCop(data.available_cop, { compact: true }), {
    size: 28,
    color: COLOR.text,
  });
  const sub = widget.addText("disponible");
  sub.font = Font.systemFont(10);
  sub.textColor = COLOR.muted;
  widget.addSpacer(6);
  addUtilizationBar(widget, data.utilization_pct);
  widget.addSpacer(2);
  const pctRow = widget.addStack();
  pctRow.layoutHorizontally();
  const pctText = pctRow.addText(`${data.utilization_pct}% usado`);
  pctText.font = Font.systemFont(10);
  pctText.textColor = COLOR.muted;
  pctRow.addSpacer();
  if (data.days_to_cutoff != null) {
    const cutoff = pctRow.addText(`corta en ${data.days_to_cutoff}d`);
    cutoff.font = Font.systemFont(10);
    cutoff.textColor = COLOR.muted;
  }
  if (stale) addStaleFooter(widget);
}

function renderMisTcs(widget, data, { size, stale }) {
  setCommonBackground(widget);
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  addHeaderText(header, "Mis tarjetas", { size: 12, color: COLOR.subtext, bold: true });
  header.addSpacer();
  const total = header.addText(formatCop(data.total_available_cop, { compact: true }));
  total.font = Font.boldSystemFont(12);
  total.textColor = COLOR.primary;
  widget.addSpacer(4);

  const rows = size === "M" ? data.cards.slice(0, 3) : data.cards.slice(0, 8);
  if (rows.length === 0) {
    const empty = widget.addText("Sin tarjetas de crédito.");
    empty.font = Font.systemFont(11);
    empty.textColor = COLOR.muted;
  }
  for (const card of rows) {
    const row = widget.addStack();
    row.layoutVertically();
    row.spacing = 2;
    const top = row.addStack();
    top.layoutHorizontally();
    top.centerAlignContent();
    const nameT = top.addText(card.name);
    nameT.font = Font.systemFont(11);
    nameT.textColor = COLOR.text;
    nameT.lineLimit = 1;
    top.addSpacer();
    const amt = top.addText(formatCop(card.available_cop, { compact: true }));
    amt.font = Font.semiboldSystemFont(11);
    amt.textColor = COLOR.text;
    addUtilizationBar(row, card.utilization_pct);
    widget.addSpacer(4);
  }
  if (stale) addStaleFooter(widget);
}

function renderHoy(widget, data, { stale }) {
  setCommonBackground(widget);
  addHeaderText(widget, data.day_label, { size: 10, color: COLOR.muted });
  widget.addSpacer(2);
  addAmountText(widget, formatCop(data.spent_cop, { compact: true }), { size: 28 });
  const txLine = widget.addText(`${data.tx_count} ${data.tx_count === 1 ? "tx" : "txs"} hoy`);
  txLine.font = Font.systemFont(11);
  txLine.textColor = COLOR.muted;
  widget.addSpacer(6);
  if (data.vs_daily_avg_pct != null) {
    const up = data.vs_daily_avg_pct > 0;
    const flat = data.vs_daily_avg_pct === 0;
    const arrow = flat ? "→" : up ? "↑" : "↓";
    const color = flat ? COLOR.muted : up ? COLOR.danger : COLOR.success;
    const cmpRow = widget.addStack();
    cmpRow.layoutHorizontally();
    cmpRow.centerAlignContent();
    const ar = cmpRow.addText(`${arrow} ${Math.abs(data.vs_daily_avg_pct)}%`);
    ar.font = Font.semiboldSystemFont(11);
    ar.textColor = color;
    cmpRow.addSpacer(4);
    const vs = cmpRow.addText("vs. promedio");
    vs.font = Font.systemFont(10);
    vs.textColor = COLOR.muted;
  } else {
    const placeholder = widget.addText("sin comparación");
    placeholder.font = Font.systemFont(10);
    placeholder.textColor = COLOR.mutedDim;
  }
  if (stale) addStaleFooter(widget);
}

function renderMesActual(widget, data, { stale }) {
  setCommonBackground(widget);
  addHeaderText(widget, data.month_label, { size: 11, color: COLOR.subtext, bold: true });
  widget.addSpacer(2);

  const cols = widget.addStack();
  cols.layoutHorizontally();
  cols.spacing = 8;

  // Left column — spent + projection.
  const left = cols.addStack();
  left.layoutVertically();
  left.spacing = 2;
  const spent = left.addText(formatCop(data.spent_cop, { compact: true }));
  spent.font = Font.boldSystemFont(26);
  spent.textColor = COLOR.text;
  spent.minimumScaleFactor = 0.6;
  spent.lineLimit = 1;
  const proj = left.addText(
    `de ~${formatCop(data.projection_month_end_cop, { compact: true })} proyectado`,
  );
  proj.font = Font.systemFont(10);
  proj.textColor = COLOR.muted;
  proj.lineLimit = 1;
  proj.minimumScaleFactor = 0.7;

  cols.addSpacer();

  // Right column — delta vs last month.
  const right = cols.addStack();
  right.layoutVertically();
  right.spacing = 2;
  if (data.delta_pct != null && data.delta_direction) {
    const up = data.delta_direction === "up";
    const flat = data.delta_direction === "flat";
    const arrow = flat ? "→" : up ? "↑" : "↓";
    const color = flat ? COLOR.muted : up ? COLOR.danger : COLOR.success;
    const deltaT = right.addText(`${arrow} ${Math.abs(data.delta_pct)}%`);
    deltaT.font = Font.boldSystemFont(16);
    deltaT.textColor = color;
    const cmp = right.addText("vs mes pasado");
    cmp.font = Font.systemFont(9);
    cmp.textColor = COLOR.muted;
  } else {
    const placeholder = right.addText("sin comparación");
    placeholder.font = Font.systemFont(10);
    placeholder.textColor = COLOR.mutedDim;
  }
  const dayT = right.addText(`día ${data.day_of_month}`);
  dayT.font = Font.systemFont(9);
  dayT.textColor = COLOR.mutedDim;

  if (stale) addStaleFooter(widget);
}

function renderRecentTx(widget, data, { size, stale }) {
  setCommonBackground(widget);
  addHeaderText(widget, "Últimas transacciones", {
    size: 11,
    color: COLOR.subtext,
    bold: true,
  });
  widget.addSpacer(4);
  const rows = (data.transactions ?? []).slice(0, size === "M" ? 3 : 5);
  if (rows.length === 0) {
    const empty = widget.addText("Sin movimientos recientes.");
    empty.font = Font.systemFont(11);
    empty.textColor = COLOR.muted;
  }
  for (const tx of rows) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const left = row.addStack();
    left.layoutVertically();
    left.spacing = 1;
    const merchT = left.addText(tx.merchant || "—");
    merchT.font = Font.semiboldSystemFont(11);
    merchT.textColor = COLOR.text;
    merchT.lineLimit = 1;
    const subParts = [];
    if (tx.category_name) subParts.push(tx.category_name);
    if (tx.account_label) subParts.push(tx.account_label);
    const subT = left.addText(subParts.join(" · "));
    subT.font = Font.systemFont(9);
    subT.textColor = COLOR.muted;
    subT.lineLimit = 1;

    row.addSpacer();

    const amount = tx.amount_cop;
    const amtColor = amount > 0 ? COLOR.success : amount < 0 ? COLOR.danger : COLOR.muted;
    const amtT = row.addText(formatCop(amount, { compact: true, signed: true }));
    amtT.font = Font.semiboldSystemFont(11);
    amtT.textColor = amtColor;
    widget.addSpacer(4);
  }
  if (stale) addStaleFooter(widget);
}

// ----------------------------------------------------------------------------
// Dispatcher.
// ----------------------------------------------------------------------------

function renderPayload(widget, parsed, payload, { stale = false } = {}) {
  const data = payload?.data ?? {};
  const opts = { size: parsed.size, stale };
  switch (parsed.widgetId) {
    case "tc-focus":
      return renderTcFocus(widget, data, opts);
    case "mis-tcs":
      return renderMisTcs(widget, data, opts);
    case "hoy":
      return renderHoy(widget, data, opts);
    case "mes-actual":
      return renderMesActual(widget, data, opts);
    case "recent-tx":
      return renderRecentTx(widget, data, opts);
    default:
      return renderError(widget, "Widget desconocido.");
  }
}

function renderError(widget, message) {
  setCommonBackground(widget);
  const title = widget.addText("Findash");
  title.font = Font.semiboldSystemFont(12);
  title.textColor = COLOR.subtext;
  widget.addSpacer(6);
  const msg = widget.addText(message);
  msg.font = Font.systemFont(11);
  msg.textColor = COLOR.danger;
  msg.lineLimit = 4;
}

// ----------------------------------------------------------------------------
// Entry point.
// ----------------------------------------------------------------------------

async function main() {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  const token = keychainGet("FINDASH_TOKEN");
  const baseUrl = keychainGet("FINDASH_BASE_URL");
  if (!token || !baseUrl) {
    renderError(widget, "Faltan credenciales. Corré el script findash-set-token.js una vez.");
    return widget;
  }

  const parameterRaw = args.widgetParameter || DEFAULT_PREVIEW_PARAM;
  let parsed;
  try {
    parsed = parseParameter(parameterRaw);
  } catch (_e) {
    renderError(widget, `Parámetro inválido: "${parameterRaw}". Formato: <id>.<size>[|<extra>]`);
    return widget;
  }

  try {
    const payload = await fetchWidget({
      baseUrl,
      token,
      widgetId: parsed.widgetId,
      size: parsed.size,
      extra: parsed.extra,
    });
    saveCache(parameterRaw, payload);
    renderPayload(widget, parsed, payload, { stale: false });
  } catch (err) {
    console.error("findash-widget error:", err);
    console.error("stack:", err?.stack);
    if (err instanceof FindashError && err.kind === "auth") {
      renderError(widget, err.message);
    } else if (err instanceof FindashError && err.kind === "unknown-widget") {
      renderError(widget, err.message);
    } else {
      const cached = loadCache(parameterRaw);
      if (cached?.payload) {
        renderPayload(widget, parsed, cached.payload, { stale: true });
      } else if (err instanceof FindashError && err.kind === "network") {
        renderError(widget, "Sin conexión.");
      } else {
        const name = err?.name || "Error";
        const msg = err?.message || String(err);
        const stackLine = (err?.stack || "").split("\n")[0] || "";
        renderError(widget, `${name}: ${msg}\n${stackLine}`);
      }
    }
  }

  return widget;
}

// ----------------------------------------------------------------------------
// Scriptable boilerplate — route to the appropriate presentation mode.
// ----------------------------------------------------------------------------

const widget = await main();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // When opened in the Scriptable app we preview as the medium size to give a
  // reasonable approximation of what the home-screen widget will look like.
  await widget.presentMedium();
}
Script.complete();
