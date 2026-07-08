// GET /api/sheets/auto
// 登入(團隊密碼驗證通過)之後,前端會背景打這支 API 一次,自動幫目前身份能看的每個品牌
// 檢查「今天有沒有同步過 Google 試算表」,沒有的話自動抓一次,不用再手動點「從 Google 試算表同步」。
//
// 用 last-sync-date:{accountId} 這個 KV key 記錄「這個帳號最後一次成功同步的日期(台灣時區)」,
// 一天只會真的打一次 Google API——不管同一天內重新整理頁面幾次、幾個人同時打開網站,
// 都不會重複觸發,避免撞到 Google Sheets API 的額度上限。
//
// 「測試」這種 brands === "*" 的最高權限身份,會自動掃過所有「已經綁定過試算表」的品牌
// (用 KV 的 sheet-map: 前綴列出來),包含以後新增的品牌也會自動含進去,不用手動維護清單。

import { getGoogleAccessToken } from "../../_shared/googleAuth.js";
import { syncAccountLedger, todayInTaiwan } from "../../_shared/sheetSync.js";

export async function onRequestGet({ env, data }) {
  const credential = data.credential;
  if (!credential) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    // 還沒設定 Google 服務帳號金鑰,安靜地跳過(不算錯誤),前端不用特別顯示什麼。
    return new Response(JSON.stringify({ synced: [], skipped: [], errors: [] }), { headers: { "Content-Type": "application/json" } });
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    return new Response(JSON.stringify({ synced: [], skipped: [], errors: ["GOOGLE_SERVICE_ACCOUNT_KEY 不是合法的 JSON"] }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 決定要檢查哪些帳號:最高權限身份 -> 掃過所有已經綁定過試算表的帳號;範圍受限的身份 -> 只看自己權限內的。
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

  let accessToken = null; // 同一次 request 裡,所有帳號共用同一個服務帳號 access token,不用每個帳號各換一次。

  for (const accountId of accountIds) {
    const lastSync = await env.REPORT_KV.get(`last-sync-date:${accountId}`);
    if (lastSync === today) { skipped.push(accountId); continue; }

    const sheetId = await env.REPORT_KV.get(`sheet-map:${accountId}`);
    if (!sheetId) { skipped.push(accountId); continue; }

    try {
      if (!accessToken) accessToken = await getGoogleAccessToken(serviceAccount);
      const { importedMonths, errors: tabErrors } = await syncAccountLedger(env, accessToken, accountId, sheetId, year);
      if (importedMonths.length) {
        await env.REPORT_KV.put(`last-sync-date:${accountId}`, today);
        synced.push(accountId);
      } else if (tabErrors.length) {
        errors.push(`${accountId}: ${tabErrors[0]}`);
      }
    } catch (e) {
      errors.push(`${accountId}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ synced, skipped, errors, date: today }), { headers: { "Content-Type": "application/json" } });
}
