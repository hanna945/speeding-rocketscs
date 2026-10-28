const BRAND_ID = "1638891154598307";
const MONTH_PREFIX = `metaads-month:${BRAND_ID}::`;
const WEEK_PREFIX = `metaads-week:${BRAND_ID}::`;
const LEDGER_PREFIX = `metaads-ledger:${BRAND_ID}::`;

function corsHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60, s-maxage=60",
  };
}

async function readJson(env, key, fallback = null) {
  const raw = await env.REPORT_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function readPrefixMap(env, prefix) {
  const out = {};
  let cursor;
  do {
    const page = await env.REPORT_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const raw = await env.REPORT_KV.get(item.name);
      if (!raw) continue;
      try {
        const key = item.name.slice(prefix.length);
        out[key] = JSON.parse(raw);
      } catch {
        // Ignore malformed legacy records instead of breaking the public read-only feed.
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

function scopedSetting(obj) {
  if (!obj || typeof obj !== "object") return null;
  return Object.prototype.hasOwnProperty.call(obj, BRAND_ID) ? obj[BRAND_ID] : null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env }) {
  try {
    const [
      months,
      weeks,
      ledger,
      cpaAll,
      adRatioAll,
      roasAll,
      budgetAll,
      productNamesAll,
    ] = await Promise.all([
      readPrefixMap(env, MONTH_PREFIX),
      readPrefixMap(env, WEEK_PREFIX),
      readPrefixMap(env, LEDGER_PREFIX),
      readJson(env, "meta-api-cpa-thresholds", {}),
      readJson(env, "meta-api-adratio-thresholds", {}),
      readJson(env, "meta-api-roas-targets", {}),
      readJson(env, "meta-api-monthly-budgets", {}),
      readJson(env, "meta-api-product-names", {}),
    ]);

    return new Response(JSON.stringify({
      ok: true,
      brand: {
        id: BRAND_ID,
        name: "Liaoliao 撩撩",
      },
      months,
      weeks,
      ledger,
      settings: {
        cpaTarget: scopedSetting(cpaAll),
        adRatioThreshold: scopedSetting(adRatioAll),
        roasTarget: scopedSetting(roasAll),
        monthlyBudget: scopedSetting(budgetAll),
        productNames: scopedSetting(productNamesAll) || {},
      },
      generatedAt: new Date().toISOString(),
      mode: "READ_ONLY",
    }), { status: 200, headers: corsHeaders() });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: "public_report_read_failed",
      message: error && error.message ? error.message : String(error),
    }), { status: 500, headers: corsHeaders() });
  }
}
