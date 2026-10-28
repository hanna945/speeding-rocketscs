const BRAND_KEYS = {
  mavis: "brand-ui-logo:mavis",
  liaoliao: "brand-ui-logo:liaoliao",
};
const MAX_DATA_URL_LENGTH = 1200000;

function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers() });
}

function normalizeBrand(value) {
  const brand = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BRAND_KEYS, brand) ? brand : "";
}

function validDataUrl(value) {
  return typeof value === "string" &&
    value.length > 20 &&
    value.length <= MAX_DATA_URL_LENGTH &&
    /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: headers() });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const brand = normalizeBrand(url.searchParams.get("brand"));
  if (!brand) return json({ ok: false, error: "invalid_brand" }, 400);

  const raw = await env.REPORT_KV.get(BRAND_KEYS[brand]);
  if (!raw) return json({ ok: true, brand, logo: null });

  try {
    const record = JSON.parse(raw);
    return json({
      ok: true,
      brand,
      logo: validDataUrl(record && record.dataUrl) ? record.dataUrl : null,
      updatedAt: record && record.updatedAt ? record.updatedAt : null,
    });
  } catch {
    return json({ ok: true, brand, logo: validDataUrl(raw) ? raw : null });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const brand = normalizeBrand(body && body.brand);
    const dataUrl = body && body.dataUrl;
    if (!brand) return json({ ok: false, error: "invalid_brand" }, 400);
    if (!validDataUrl(dataUrl)) return json({ ok: false, error: "invalid_logo" }, 400);

    const record = {
      dataUrl,
      updatedAt: new Date().toISOString(),
    };
    await env.REPORT_KV.put(BRAND_KEYS[brand], JSON.stringify(record));
    return json({ ok: true, brand, updatedAt: record.updatedAt });
  } catch (error) {
    return json({ ok: false, error: "logo_save_failed", message: error && error.message ? error.message : String(error) }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const brand = normalizeBrand(url.searchParams.get("brand"));
  if (!brand) return json({ ok: false, error: "invalid_brand" }, 400);
  await env.REPORT_KV.delete(BRAND_KEYS[brand]);
  return json({ ok: true, brand, deleted: true });
}
