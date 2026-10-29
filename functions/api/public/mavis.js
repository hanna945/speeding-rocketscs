const BRAND_NAME_MATCH = /mavis/i;

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
      try { out[item.name.slice(prefix.length)] = JSON.parse(raw); } catch {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
function scopedSetting(obj, brandId) {
  if (!obj || typeof obj !== "object") return null;
  return Object.prototype.hasOwnProperty.call(obj, brandId) ? obj[brandId] : null;
}
function sanitizeLedgerMap(ledger) {
  const out = {};
  for (const [monthKey, record] of Object.entries(ledger || {})) {
    if (!record || typeof record !== "object") continue;
    out[monthKey] = {
      monthKey: record.monthKey || monthKey,
      year: record.year || null,
      month: record.month || null,
      days: Array.isArray(record.days) ? record.days : [],
      monthTotal: record.monthTotal || null,
      productCodes: Array.isArray(record.productCodes) ? record.productCodes : [],
      onePageProductCodes: Array.isArray(record.onePageProductCodes) ? record.onePageProductCodes : [],
      officialSiteCodes: Array.isArray(record.officialSiteCodes) ? record.officialSiteCodes : [],
      externalChannelCodes: Array.isArray(record.externalChannelCodes) ? record.externalChannelCodes : [],
      salesPlatformCodes: Array.isArray(record.salesPlatformCodes) ? record.salesPlatformCodes : [],
      adSourceCodes: Array.isArray(record.adSourceCodes) ? record.adSourceCodes : [],
    };
  }
  return out;
}
async function resolveBrand(env) {
  const brands = await readJson(env, "meta-api-brands", []);
  let brand = (Array.isArray(brands) ? brands : []).find((b) => b && BRAND_NAME_MATCH.test(String(b.name || "")));
  if (brand && brand.id) return { id: String(brand.id), name: brand.name || "Halo-Mavis" };

  // Some internal brands live only in TEAM_CREDENTIALS and are intentionally not in the shared favorite-brand list.
  // Parse only brand roster metadata here; never return credential keys or unrelated brands.
  if (env.TEAM_CREDENTIALS) {
    try {
      const credentials = JSON.parse(env.TEAM_CREDENTIALS);
      for (const entry of Object.values(credentials || {})) {
        const roster = entry && Array.isArray(entry.brands) ? entry.brands : [];
        brand = roster.find((b) => b && typeof b === "object" && b.id && BRAND_NAME_MATCH.test(String(b.name || "")));
        if (brand) return { id: String(brand.id), name: brand.name || "Halo-Mavis" };
      }
    } catch {}
  }

  throw new Error("Mavis brand not found in shared brand configuration");
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env }) {
  try {
    const brand = await resolveBrand(env);
    const monthPrefix = `metaads-month:${brand.id}::`;
    const ledgerPrefix = `metaads-ledger:${brand.id}::`;
    const [
      months, ledger, cpaAll, cpcAll, adRatioAll, roasAll, budgetAll, productNamesAll,
    ] = await Promise.all([
      readPrefixMap(env, monthPrefix),
      readPrefixMap(env, ledgerPrefix),
      readJson(env, "meta-api-cpa-thresholds", {}),
      readJson(env, "meta-api-cpc-thresholds", {}),
      readJson(env, "meta-api-adratio-thresholds", {}),
      readJson(env, "meta-api-roas-targets", {}),
      readJson(env, "meta-api-monthly-budgets", {}),
      readJson(env, "meta-api-product-names", {}),
    ]);
    return new Response(JSON.stringify({
      ok: true,
      brand,
      months,
      ledger: sanitizeLedgerMap(ledger),
      settings: {
        cpaTarget: scopedSetting(cpaAll, brand.id),
        cpcTarget: scopedSetting(cpcAll, brand.id),
        adRatioThreshold: scopedSetting(adRatioAll, brand.id),
        roasTarget: scopedSetting(roasAll, brand.id),
        monthlyBudget: scopedSetting(budgetAll, brand.id),
        productNames: scopedSetting(productNamesAll, brand.id) || {},
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
