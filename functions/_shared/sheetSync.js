// Read Google Sheets monthly tabs, parse them with semantic/brand-aware rules,
// and persist only validated results.

import { fetchSheetMonthValues, sheetsValuesToMatrix } from "./googleAuth.js";
import { parseLedgerSheet } from "./ledgerParser.js";

export const MONTH_TABS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
export const LEDGER_STORAGE_PREFIX = "metaads-ledger:";

export async function syncAccountLedger(env, accessToken, accountId, sheetId, year) {
  const importedMonths = [];
  const errors = [];
  const warnings = [];
  const validationErrors = [];

  // For the current year, do not treat future calendar months as missing-sheet errors.
  // Historical years still scan all 12 months; future years keep the old behavior.
  const twNow = new Date(Date.now() + 8 * 3600 * 1000);
  const twYear = twNow.getUTCFullYear();
  const twMonth = twNow.getUTCMonth() + 1;
  const tabsToSync = year === twYear ? MONTH_TABS.slice(0, twMonth) : MONTH_TABS;

  for (const tab of tabsToSync) {
    let values;
    try {
      values = await fetchSheetMonthValues(accessToken, sheetId, tab);
    } catch (e) {
      // Missing tabs / Google API read errors stay in the ordinary error bucket.
      // They are different from "the sheet exists but our parser cannot safely map it".
      errors.push(`${tab}: ${e.message}`);
      continue;
    }
    if (!values.length) continue;

    let parsed;
    try {
      parsed = parseLedgerSheet(sheetsValuesToMatrix(values), year, { accountId, sheetId, tab });
    } catch (e) {
      const msg = `${tab}: 解析失敗(${e.message})`;
      errors.push(msg);
      validationErrors.push(msg);
      continue;
    }
    if (!parsed) continue;

    const diag = parsed.diagnostics || { errors: [], warnings: [] };
    if (diag.errors && diag.errors.length) {
      // Critical: do NOT overwrite previously-good KV data with guessed/zeroed values.
      const msg = `${tab}: 欄位辨識失敗[${diag.profile || "unknown"}] ${diag.errors.join("；")}`;
      errors.push(msg);
      validationErrors.push(msg);
      continue;
    }
    if (diag.warnings && diag.warnings.length) {
      warnings.push(`${tab}: [${diag.profile || "unknown"}] ${diag.warnings.join("；")}`);
    }
    if (!parsed.days || !parsed.days.length) {
      const msg = `${tab}: 沒有可匯入的每日資料`;
      errors.push(msg);
      validationErrors.push(msg);
      continue;
    }

    const monthNum = MONTH_TABS.indexOf(tab) + 1;
    const monthKey = `${year}-${String(monthNum).padStart(2, "0")}`;
    const record = { monthKey, year, month: monthNum, ...parsed };
    await env.REPORT_KV.put(`${LEDGER_STORAGE_PREFIX}${accountId}::${monthKey}`, JSON.stringify(record));
    importedMonths.push(monthKey);
  }

  return { importedMonths, errors, warnings, validationErrors };
}

export function todayInTaiwan() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}
