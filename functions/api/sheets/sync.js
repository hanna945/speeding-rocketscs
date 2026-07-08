// POST /api/sheets/sync
// body: { accountId: "廣告帳號ID", sheetId: "Google 試算表ID(選填,留空沿用上次記住的)", year: 2026 }
//
// 這支 Function 會:
//   1. 用公司的 Google 服務帳號金鑰(存在 Secret 環境變數 GOOGLE_SERVICE_ACCOUNT_KEY)跟 Google 換一個短期 access token
//   2. 依序讀取試算表裡「1月」~「12月」這些分頁(只要存在的都會讀,沒有的分頁略過)
//   3. 用跟 xlsx 匯入完全同一套解析邏輯(functions/_shared/ledgerParser.js)轉成後台每日資料
//   4. 直接寫進跟前端「匯入後台每日收益表」按鈕同一個 KV 位置,
//      所以匯入完之後,報表頁面重新整理就會直接看到,不用再手動下載/上傳 xlsx。
//
// 這份試算表完全不需要公開分享——只要分享給服務帳號的 email(檢視者權限)就好。
// 同一個 accountId 之後也會記住對應的 sheetId(存在 KV 的 sheet-map:accountId),
// 所以之後可以只帶 accountId 觸發重新同步,不用每次都重複帶 sheetId。
//
// 權限:這個帳號(accountId)必須在目前登入身份的允許品牌清單裡,否則 403——
// 避免「品牌C部」的密碼被拿去同步/查詢其他部門品牌的試算表。

import { getGoogleAccessToken } from "../../_shared/googleAuth.js";
import { syncAccountLedger, todayInTaiwan } from "../../_shared/sheetSync.js";

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ request, env, data }) {
  const credential = data.credential;

  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return jsonError(
      "尚未設定 GOOGLE_SERVICE_ACCOUNT_KEY。請到 Cloudflare Pages 的 Settings → Environment variables,新增一個型別為 Secret 的變數,值貼上服務帳號 JSON 金鑰檔的完整內容。",
      500
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonError("要求格式錯誤,body 需要是 JSON。", 400); }

  const accountId = (body.accountId || "").trim().replace(/^act_/, "");
  const year = Number(body.year);
  let sheetId = (body.sheetId || "").trim();

  if (!accountId) return jsonError("缺少 accountId(廣告帳號 ID)。", 400);
  if (!year) return jsonError("缺少 year(要匯入哪一年的分頁)。", 400);

  if (credential && credential.brands !== "*" && !credential.brands.includes(accountId)) {
    return jsonError("這組登入身份沒有這個廣告帳號的權限。", 403);
  }

  if (!sheetId) {
    sheetId = await env.REPORT_KV.get(`sheet-map:${accountId}`);
    if (!sheetId) return jsonError(`這個廣告帳號(${accountId})還沒設定對應的 Google 試算表 ID,請先貼一次 sheetId。`, 400);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    return jsonError("GOOGLE_SERVICE_ACCOUNT_KEY 不是合法的 JSON,請確認貼的是完整的金鑰檔內容(不是檔案路徑或部分內容)。", 500);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    return jsonError("跟 Google 驗證失敗:" + e.message + "(請確認金鑰內容正確、且這份試算表已經分享給服務帳號的 email)", 502);
  }

  const { importedMonths, errors: tabErrors } = await syncAccountLedger(env, accessToken, accountId, sheetId, year);

  // 記住這個帳號對應的試算表,下次可以只帶 accountId;同時順手記一筆「今天已經人工同步過」,
  // 讓登入後的自動背景同步(/api/sheets/auto)今天不會再重複打一次。
  await env.REPORT_KV.put(`sheet-map:${accountId}`, sheetId);
  await env.REPORT_KV.put(`last-sync-date:${accountId}`, todayInTaiwan());

  if (!importedMonths.length) {
    return jsonError(
      "沒有成功匯入任何月份。" + (tabErrors.length ? " 錯誤詳情:" + tabErrors.join(";") : "請確認分頁名稱是不是「1月」~「12月」這種格式,且欄位排列跟範例表單一致。"),
      422
    );
  }

  return new Response(JSON.stringify({ importedMonths, errors: tabErrors }), { headers: { "Content-Type": "application/json" } });
}

// GET /api/sheets/sync?accountId=xxx  查目前記住的 sheetId 對照(方便前端顯示,不用另外做一支 API)。
export async function onRequestGet({ request, env, data }) {
  const credential = data.credential;
  const accountId = (new URL(request.url).searchParams.get("accountId") || "").trim().replace(/^act_/, "");
  if (!accountId) return jsonError("缺少 accountId。", 400);
  if (credential && credential.brands !== "*" && !credential.brands.includes(accountId)) {
    return jsonError("這組登入身份沒有這個廣告帳號的權限。", 403);
  }
  const sheetId = await env.REPORT_KV.get(`sheet-map:${accountId}`);
  return new Response(JSON.stringify({ accountId, sheetId: sheetId || null }), { headers: { "Content-Type": "application/json" } });
}
