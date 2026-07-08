// 把 Google 試算表「1月」~「12月」分頁讀回來,轉成後台每日資料存進 KV。
// /api/sheets/sync.js(手動同步,單一帳號、可以帶新的 sheetId)
// 跟 /api/sheets/auto.js(登入後背景自動同步、可能一次跑好幾個帳號)共用這套邏輯,
// 避免兩邊各寫一份、之後要調整解析規則容易漏改其中一邊。

import { fetchSheetMonthValues, sheetsValuesToMatrix } from "./googleAuth.js";
import { parseLedgerSheet } from "./ledgerParser.js";

export const MONTH_TABS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
export const LEDGER_STORAGE_PREFIX = "metaads-ledger:"; // 要跟 index.html 裡的 LEDGER_STORAGE_PREFIX 完全一致

// accessToken 由呼叫端先換好再傳進來(一次 request 如果要同步多個帳號,只需要換一次 token,不用每個帳號各換一次)。
// 回傳 { importedMonths, errors }:單一分頁讀取或解析失敗不會讓整批中斷,錯誤會收集起來一起回傳。
export async function syncAccountLedger(env, accessToken, accountId, sheetId, year) {
  const importedMonths = [];
  const errors = [];
  for (const tab of MONTH_TABS) {
    let values;
    try {
      values = await fetchSheetMonthValues(accessToken, sheetId, tab);
    } catch (e) {
      errors.push(`${tab}: ${e.message}`);
      continue;
    }
    if (!values.length) continue; // 分頁不存在或是空的,直接跳過,不算錯誤

    let parsed;
    try {
      parsed = parseLedgerSheet(sheetsValuesToMatrix(values), year);
    } catch (e) {
      errors.push(`${tab}: 解析失敗(${e.message})——確認欄位排列是否跟範例表單一致`);
      continue;
    }
    if (!parsed) continue;

    const monthNum = MONTH_TABS.indexOf(tab) + 1;
    const monthKey = `${year}-${String(monthNum).padStart(2, "0")}`;
    const record = { monthKey, year, month: monthNum, ...parsed };
    await env.REPORT_KV.put(`${LEDGER_STORAGE_PREFIX}${accountId}::${monthKey}`, JSON.stringify(record));
    importedMonths.push(monthKey);
  }
  return { importedMonths, errors };
}

// 台灣固定 UTC+8,不做日光節約調整,用來判斷「今天」的日期字串(YYYY-MM-DD),
// 讓自動同步以「台灣的一天」為單位,而不是 Cloudflare 伺服器所在地的當地日期。
export function todayInTaiwan() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}
