// GET /api/sheets/auto
// Background daily sync. Parser/schema validation failures are treated as unsafe and do not overwrite good KV data.

import { getGoogleAccessToken } from "../../_shared/googleAuth.js";
import { syncAccountLedger, todayInTaiwan } from "../../_shared/sheetSync.js";

export async function onRequestGet({ env, data }) {
  const credential = data.credential;
  if (!credential) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return new Response(JSON.stringify({ synced: [], skipped: [], errors: [], warnings: [] }), { headers: { "Content-Type": "application/json" } });
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    return new Response(JSON.stringify({ synced: [], skipped: [], errors: ["GOOGLE_SERVICE_ACCOUNT_KEY 不是合法的 JSON"], warnings: [] }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let accountIds = [];
  if (credential.brands === "*") {
    const list = await env.REPORT_KV.list({ prefix: "sheet-map:", limit: 1000 });
    accountIds = list.keys.map((k) => k.name.slice("sheet-map:".length));
  } else {
    accountIds = credential.brands;
  }

  const today = todayInTaiwan();
  const year = new Date().getFullYear();
  const synced = [];
  const skipped = [];
  const errors = [];
  const warnings = [];
  let accessToken = null;

  for (const accountId of accountIds) {
    const lastSync = await env.REPORT_KV.get(`last-sync-date:${accountId}`);
    if (lastSync === today) { skipped.push(accountId); continue; }

    const sheetId = await env.REPORT_KV.get(`sheet-map:${accountId}`);
    if (!sheetId) { skipped.push(accountId); continue; }

    try {
      if (!accessToken) accessToken = await getGoogleAccessToken(serviceAccount);
      const {
        importedMonths,
        errors: tabErrors,
        warnings: tabWarnings,
        validationErrors,
      } = await syncAccountLedger(env, accessToken, accountId, sheetId, year);

      if (tabWarnings.length) warnings.push(...tabWarnings.map((w) => `${accountId}: ${w}`));

      if (importedMonths.length && !validationErrors.length) {
        await env.REPORT_KV.put(`last-sync-date:${accountId}`, today);
        synced.push(accountId);
      } else if (validationErrors.length) {
        errors.push(`${accountId}: ${validationErrors[0]}`);
      } else if (tabErrors.length) {
        errors.push(`${accountId}: ${tabErrors[0]}`);
      }
    } catch (e) {
      errors.push(`${accountId}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ synced, skipped, errors, warnings, date: today }), { headers: { "Content-Type": "application/json" } });
}
