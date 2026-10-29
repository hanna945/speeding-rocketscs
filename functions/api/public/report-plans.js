const ALLOWED_BRAND_IDS = new Set([
  "2157995930925784",
  "436280797192761",
  "2345685238995965",
  "1638891154598307",
  "1818692121940743",
]);

const PLAN_PREFIXES = ["weekly-plan:", "monthly-plan:"];
const MAX_VALUE_BYTES = 5 * 1024 * 1024;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const trusted =
    origin === "https://speedingscs.pages.dev" ||
    origin === "https://hj-brand-report.pages.dev" ||
    origin === "https://yongpingbone.github.io" ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:");
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(trusted ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request) });
}

function parsePlanKey(key) {
  const m = String(key || "").match(/^(weekly-plan|monthly-plan):([^:]+)::(\d{4}-\d{2}(?:-\d{2})?)$/);
  if (!m) return null;
  if (!ALLOWED_BRAND_IDS.has(m[2])) return null;
  return { kind: m[1], brandId: m[2], period: m[3] };
}

function validatePlanValue(raw) {
  if (typeof raw !== "string") return { ok: false, error: "value_must_be_string" };
  if (new TextEncoder().encode(raw).length > MAX_VALUE_BYTES) return { ok: false, error: "value_too_large" };
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "invalid_plan_object" };
    for (const field of ["actionItems", "projects", "materialIssues"]) {
      if (obj[field] != null && !Array.isArray(obj[field])) return { ok: false, error: "invalid_" + field };
    }
    return { ok: true, value: obj };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

async function listPlanKeys(env) {
  const keys = [];
  for (const prefix of PLAN_PREFIXES) {
    let cursor;
    do {
      const page = await env.REPORT_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const item of page.keys || []) {
        if (parsePlanKey(item.name)) keys.push(item.name);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  return keys.sort();
}

async function backupCurrent(env, key, currentRaw) {
  if (!currentRaw) return;
  const day = new Date().toISOString().slice(0, 10);
  const latestKey = `report-plan-backup-latest:${key}`;
  const dailyKey = `report-plan-backup-day:${day}::${key}`;
  await env.REPORT_KV.put(latestKey, currentRaw);
  const existingDaily = await env.REPORT_KV.get(dailyKey);
  if (!existingDaily) await env.REPORT_KV.put(dailyKey, currentRaw);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  const key = url.searchParams.get("key");
  if (key) {
    if (!parsePlanKey(key)) return json(request, { ok: false, error: "invalid_plan_key" }, 400);
    const raw = await env.REPORT_KV.get(key);
    if (raw == null) return json(request, { ok: true, key, value: null });
    return json(request, { ok: true, key, value: raw });
  }

  const keys = await listPlanKeys(env);
  return json(request, { ok: true, keys, count: keys.length });
}

export async function onRequestPut({ request, env }) {
  const origin = request.headers.get("Origin") || "";
  const trusted =
    origin === "https://speedingscs.pages.dev" ||
    origin === "https://hj-brand-report.pages.dev" ||
    origin === "https://yongpingbone.github.io" ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:");
  if (!trusted) return json(request, { ok: false, error: "untrusted_origin" }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json(request, { ok: false, error: "invalid_request_json" }, 400); }

  const key = body && body.key;
  if (!parsePlanKey(key)) return json(request, { ok: false, error: "invalid_plan_key" }, 400);
  const checked = validatePlanValue(body && body.value);
  if (!checked.ok) return json(request, { ok: false, error: checked.error }, 400);

  if (body && body.backupOnly) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await env.REPORT_KV.put(`report-plan-backup-local:${stamp}::${key}`, body.value);
    return json(request, { ok: true, key, backupOnly: true, snapshot: stamp });
  }

  const currentRaw = await env.REPORT_KV.get(key);
  if (currentRaw !== body.value) await backupCurrent(env, key, currentRaw);
  await env.REPORT_KV.put(key, body.value);
  return json(request, {
    ok: true,
    key,
    savedAt: new Date().toISOString(),
    backedUpPrevious: !!currentRaw && currentRaw !== body.value,
  });
}
