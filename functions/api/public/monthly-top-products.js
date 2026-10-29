const STATIC_BRANDS = {
  "436280797192761": "H&J官網業績",
  "2157995930925784": "H&J 一頁業績",
  "2345685238995965": "J.GAO",
  "1638891154598307": "Liaoliao 撩撩",
};

const MAVIS_NAME_MATCH = /mavis/i;
const NON_PRODUCT_CODE_PATTERN = /test|測試/i;
const OFFICIAL_SITE_NAMES = ["SHOPIFY", "SHOPLINE"];
const EXTERNAL_CHANNEL_NAMES = ["蝦皮", "MOMO", "門市", "經銷", "LINE 禮物", "LINE禮物"];

function corsHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60, s-maxage=60",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

async function readJson(env, key, fallback = null) {
  const raw = await env.REPORT_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function resolveMavisBrand(env) {
  const brands = await readJson(env, "meta-api-brands", []);
  let brand = (Array.isArray(brands) ? brands : []).find(
    (b) => b && b.id && MAVIS_NAME_MATCH.test(String(b.name || ""))
  );
  if (brand) return { id: String(brand.id), name: brand.name || "Halo-Mavis" };

  if (env.TEAM_CREDENTIALS) {
    try {
      const credentials = JSON.parse(env.TEAM_CREDENTIALS);
      for (const entry of Object.values(credentials || {})) {
        const roster = entry && Array.isArray(entry.brands) ? entry.brands : [];
        brand = roster.find(
          (b) => b && b.id && MAVIS_NAME_MATCH.test(String(b.name || ""))
        );
        if (brand) return { id: String(brand.id), name: brand.name || "Halo-Mavis" };
      }
    } catch {}
  }
  return null;
}

async function resolveBrand(env, requested) {
  const key = String(requested || "").trim();
  if (!key) return null;
  if (STATIC_BRANDS[key]) return { id: key, name: STATIC_BRANDS[key] };

  const mavis = await resolveMavisBrand(env);
  if (mavis && (key === "mavis" || key === "mavis-public" || key === mavis.id)) return mavis;
  return null;
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
        out[item.name.slice(prefix.length)] = JSON.parse(raw);
      } catch {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

function parseProductCode(campaignName) {
  const text = String(campaignName || "").trim();
  if (!text) return null;
  const match = text.match(/[【\[]([^】\]]+)[】\]]/);
  return match ? match[1].trim().toUpperCase() : null;
}

function isNonProductCode(code) {
  const raw = String(code || "").trim();
  const compact = raw.toUpperCase().replace(/\s+/g, "");
  if (!raw || NON_PRODUCT_CODE_PATTERN.test(raw)) return true;
  if (compact === "GOOGLE" || compact === "門市GOOGLE") return true;
  if (OFFICIAL_SITE_NAMES.some((name) => raw.toUpperCase().includes(name))) return true;
  if (EXTERNAL_CHANNEL_NAMES.some((name) => raw.includes(name))) return true;
  return false;
}

function buildMonthlyTop3(record) {
  const ads = record && Array.isArray(record.ads) ? record.ads : [];
  const spendingAds = ads.filter((ad) => (Number(ad && ad.spend) || 0) > 0);
  const totalAdSpend = spendingAds.reduce((sum, ad) => sum + (Number(ad.spend) || 0), 0);
  const byCode = {};

  for (const ad of spendingAds) {
    const code = parseProductCode(ad.campaign);
    if (!code || isNonProductCode(code)) continue;

    if (!byCode[code]) {
      byCode[code] = {
        code,
        spend: 0,
        conversions: 0,
        revenue: 0,
        adCount: 0,
      };
    }
    byCode[code].spend += Number(ad.spend) || 0;
    byCode[code].conversions += Number(ad.conversions) || 0;
    byCode[code].revenue += Number(ad.revenue) || 0;
    byCode[code].adCount += Number(ad.adCount) || 1;
  }

  const ranked = Object.values(byCode)
    .filter((item) => item.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  const top3 = Array.from({ length: 3 }, (_, index) => {
    const item = ranked[index];
    if (!item) return null;
    return {
      rank: index + 1,
      code: item.code,
      spend: item.spend,
      conversions: item.conversions,
      revenue: item.revenue,
      adCount: item.adCount,
      cpa: item.conversions > 0 ? item.spend / item.conversions : null,
      roas: item.spend > 0 ? item.revenue / item.spend : null,
      spendShare: totalAdSpend > 0 ? (item.spend / totalAdSpend) * 100 : 0,
    };
  });

  return {
    totalAdSpend,
    spendingAdCount: spendingAds.length,
    productCount: ranked.length,
    top3,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const requested = url.searchParams.get("brand") || url.searchParams.get("brandId");
    const brand = await resolveBrand(env, requested);
    if (!brand) {
      return jsonResponse({ ok: false, error: "brand_not_allowed" }, 403);
    }

    const prefix = `metaads-month:${brand.id}::`;
    const rawMonths = await readPrefixMap(env, prefix);
    const months = {};
    for (const [monthKey, record] of Object.entries(rawMonths)) {
      months[monthKey] = buildMonthlyTop3(record);
    }

    return jsonResponse({
      ok: true,
      source: "brand-report-central",
      brand,
      months,
      generatedAt: new Date().toISOString(),
      rule: "rank_by_monthly_spend_all_ads_with_spend_gt_0",
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "monthly_top_products_failed",
      message: error && error.message ? error.message : String(error),
    }, 500);
  }
}
