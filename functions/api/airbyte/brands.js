import { verifyGitHubActionsOidc } from "../../_shared/githubOidc.js";
import { extendCredentialRoster } from "../../_shared/brandDefaults.js";

const HJ_OFFICIAL_ACCOUNT = { id: "436280797192761", name: "H&J官網業績" };

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
  if (!brand) return;
  const existing = map.get(brand.id);
  if (!existing || existing.name === existing.id) map.set(brand.id, brand);
}

function configuredBrandsFromEnv(env) {
  const out = [];
  if (!env.TEAM_CREDENTIALS) return out;
  try {
    const creds = JSON.parse(env.TEAM_CREDENTIALS);
    Object.values(creds || {}).forEach((entry) => {
      const rawList = entry && Array.isArray(entry.brands) ? entry.brands : [];
      const normalized = rawList
        .map((brand) => normalizeBrand(brand))
        .filter(Boolean);
      const extended = extendCredentialRoster((entry && entry.name) || "", normalized);
      extended.forEach((brand) => out.push(brand));
    });
  } catch {}
  return out;
}

export async function onRequestGet({ request, env }) {
  const claims = await verifyGitHubActionsOidc(request);
  if (!claims) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized_machine_identity" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const map = new Map();
  configuredBrandsFromEnv(env).forEach((brand) => mergeBrand(map, brand));
  // H&J has two real Meta ad accounts. The official-site account is intentionally hidden
  // from the main brand switch UI to avoid duplicate reporting surfaces, but Airbyte still
  // needs to sync it for the dedicated H&J report.
  mergeBrand(map, HJ_OFFICIAL_ACCOUNT);

  const rawShared = await env.REPORT_KV.get("meta-api-brands");
  if (rawShared) {
    try {
      const shared = JSON.parse(rawShared);
      if (Array.isArray(shared)) shared.forEach((brand) => mergeBrand(map, brand));
    } catch {}
  }

  const brands = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  return new Response(JSON.stringify({
    ok: true,
    mode: "MACHINE_ONLY_READ_WRITE",
    auth: "github_actions_oidc",
    repository: claims.repository,
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
