// Built-in brand mappings that should be available without changing Cloudflare TEAM_CREDENTIALS.
// Keep this file limited to non-secret identifiers only.

const BRAND_C_ACCOUNT_ID = "1638891154598307";
const BRAND_C_NAME = "撩撩";
const BRAND_C_SHEET_ID = "1zVyUBnDZVQ2wopks1b1vWox-K3zI57TBoq2o7ixlfCo";

function normalizeCredentialName(name) {
  return String(name || "").replace(/\s+/g, "").toUpperCase();
}

export function extendCredentialRoster(credentialName, roster) {
  const list = Array.isArray(roster) ? [...roster] : [];
  const normalizedName = normalizeCredentialName(credentialName);
  if (normalizedName !== "品牌C" && normalizedName !== "品牌C部") return list;

  if (!list.some((b) => b && b.id === BRAND_C_ACCOUNT_ID)) {
    list.push({ id: BRAND_C_ACCOUNT_ID, name: BRAND_C_NAME });
  }
  return list;
}

export function getDefaultSheetId(accountId) {
  const normalized = String(accountId || "").trim().replace(/^act_/, "");
  if (normalized === BRAND_C_ACCOUNT_ID) return BRAND_C_SHEET_ID;
  return null;
}
