import { resolveCredential } from "../../_shared/auth.js";

const HIDDEN_REPORT_BRAND_NAMES = new Set(["H&J官網業績"]);

function normalizeBrand(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const id = raw.trim().replace(/^act_/, "");
    return id ? { id, name: id } : null;
  }
  const id = String(raw.id || "").trim().replace(/^act_/, "");
  if (!id) return null;
  return { id, name: String(raw.name || id).trim() || id };
}

function mergeBrand(map, raw) {
  const brand = normalizeBrand(raw);
  if (!brand || HIDDEN_REPORT_BRAND_NAMES.has(brand.name)) return;
  const existing = map.get(brand.id);
  if (!existing || existing.name === existing.id) map.set(brand.id, brand);
}

function configuredBrandsFromEnv(env) {
  const out = [];
  if (!env.TEAM_CREDENTIALS) return out;
  try {
    const creds = JSON.parse(env.TEAM_CREDENTIALS);
    Object.values(creds || {}).forEach((entry) => {
      const list = entry && Array.isArray(entry.brands) ? entry.brands : [];
      list.forEach((brand) => out.push(brand));
    });
  } catch {}
  return out;
}

function resolveSyncCredential(request, env) {
  if (env.TEAM_CREDENTIALS) return resolveCredential(request, env);
  const provided = request.headers.get("X-Team-Key") || "";
  if (env.TEAM_SECRET && provided !== env.TEAM_SECRET) return null;
  return { name: "Airbyte Sync", brands: "*", roster: null };
}

export async function onRequestGet({ request, env }) {
  const credential = resolveSyncCredential(request, env);
  if (!credential) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const map = new Map();
  const rawShared = await env.REPORT_KV.get("meta-api-brands");
  if (rawShared) {
    try {
      const shared = JSON.parse(rawShared);
      if (Array.isArray(shared)) shared.forEach((brand) => mergeBrand(map, brand));
    } catch {}
  }

  if (credential.brands === "*") {
    configuredBrandsFromEnv(env).forEach((brand) => mergeBrand(map, brand));
  } else {
    (credential.roster || []).forEach((brand) => mergeBrand(map, brand));
    (credential.brands || []).forEach((id) => {
      if (!map.has(id)) mergeBrand(map, { id, name: id });
    });
    for (const id of [...map.keys()]) {
      if (!credential.brands.includes(id)) map.delete(id);
    }
  }

  const brands = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  return new Response(JSON.stringify({
    ok: true,
    mode: "READ_ONLY",
    credential: credential.name || "",
    brands,
    count: brands.length,
    generatedAt: new Date().toISOString(),
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
