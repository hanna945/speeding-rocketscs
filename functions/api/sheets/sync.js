// POST /api/sheets/sync
// body: { accountId: "廣告帳號ID", sheetId: "Google 試算表ID(選填,留空沿用上次記住的)", year: 2026 }

import { getGoogleAccessToken } from "../../_shared/googleAuth.js";
import { syncAccountLedger, todayInTaiwan } from "../../_shared/sheetSync.js";

function jsonError(message, status, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  const {
    importedMonths,
    errors: tabErrors,
    warnings,
    validationErrors,
  } = await syncAccountLedger(env, accessToken, accountId, sheetId, year);

  // Remember the mapping even when validation fails, so the user does not need to paste sheetId again.
  await env.REPORT_KV.put(`sheet-map:${accountId}`, sheetId);

  // Only mark today as successfully synced when there was no parser/schema validation failure.
  // Ordinary missing future tabs do not block this flag; dangerous field mis-mapping does.
  if (importedMonths.length && !validationErrors.length) {
    await env.REPORT_KV.put(`last-sync-date:${accountId}`, todayInTaiwan());
  }

  if (!importedMonths.length) {
    return jsonError(
      "沒有成功匯入任何月份。" +
        (validationErrors.length
          ? " 試算表欄位結構無法安全辨識，已保留原本資料、不會覆蓋。"
          : tabErrors.length
            ? " 錯誤詳情:" + tabErrors.join(";")
            : "請確認分頁名稱是不是「1月」~「12月」這種格式。"),
      422,
      { errors: tabErrors, warnings, validationErrors }
    );
  }

  return new Response(
    JSON.stringify({ importedMonths, errors: tabErrors, warnings, validationErrors }),
    { headers: { "Content-Type": "application/json" } }
  );
}

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
