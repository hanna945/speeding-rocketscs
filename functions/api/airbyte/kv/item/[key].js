import { extendCredentialRoster } from "../../../../_shared/brandDefaults.js";

import { verifyGitHubActionsOidc } from "../../../../_shared/githubOidc.js";

const DOUBLE_COLON_PREFIXES = ["metaads-month:", "metaads-week:", "airbyte-cache:", "airbyte-day-baseline:"];
const DIRECT_PREFIXES = ["airbyte-meta:"];
const HJ_OFFICIAL_ACCOUNT_ID = "436280797192761";

function brandIdFromKey(key) {
  for (const prefix of DOUBLE_COLON_PREFIXES) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      const idx = rest.indexOf("::");
      return idx > 0 ? rest.slice(0, idx) : null;
    }
  }
  for (const prefix of DIRECT_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length) || null;
  }
  return null;
}

function normalizeBrandId(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim().replace(/^act_/, "");
  return String(raw.id || "").trim().replace(/^act_/, "");
}

async function allowedBrandIds(env) {
  const ids = new Set();

  if (env.TEAM_CREDENTIALS) {
    try {
      const creds = JSON.parse(env.TEAM_CREDENTIALS);
      Object.values(creds || {}).forEach((entry) => {
        const rawList = entry && Array.isArray(entry.brands) ? entry.brands : [];
        const normalized = rawList
          .map((brand) => {
            const id = normalizeBrandId(brand);
            if (!id) return null;
            return typeof brand === "string"
              ? { id, name: id }
              : { id, name: String(brand.name || id) };
          })
          .filter(Boolean);
        const extended = extendCredentialRoster((entry && entry.name) || "", normalized);
        extended.forEach((brand) => {
          const id = normalizeBrandId(brand);
          if (id) ids.add(id);
        });
      });
    } catch {}
  }

  ids.add(HJ_OFFICIAL_ACCOUNT_ID);

  const rawShared = await env.REPORT_KV.get("meta-api-brands");
  if (rawShared) {
    try {
      const shared = JSON.parse(rawShared);
      if (Array.isArray(shared)) {
        shared.forEach((brand) => {
          const id = normalizeBrandId(brand);
          if (id) ids.add(id);
        });
      }
    } catch {}
  }

  return ids;
}

async function authorize(request, env, key) {
  const claims = await verifyGitHubActionsOidc(request);
  if (!claims) return { ok: false, status: 401, error: "unauthorized_machine_identity" };

  const brandId = brandIdFromKey(key);
  if (!brandId) return { ok: false, status: 403, error: "airbyte_key_not_allowed" };

  const allowed = await allowedBrandIds(env);
  if (!allowed.has(brandId)) return { ok: false, status: 403, error: "unknown_brand" };

  return { ok: true, claims, brandId };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ request, params, env }) {
  const key = decodeURIComponent(params.key);
  const auth = await authorize(request, env, key);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const value = await env.REPORT_KV.get(key);
  if (value === null) return json(null, 404);
  return json({ key, value });
}

export async function onRequestPut({ request, params, env }) {
  const key = decodeURIComponent(params.key);
  const auth = await authorize(request, env, key);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const value = await request.text();
  await env.REPORT_KV.put(key, value);
  return json({ ok: true, key, brandId: auth.brandId });
}
