// 這個 middleware 套用在 /api/kv/* 底下所有請求,負責兩件事:
//   1. 驗證 X-Team-Key 對應到哪一組登入身份(名稱 + 能看哪些品牌),身份解析邏輯共用 functions/_shared/auth.js。
//   2. 依 KV key 本身的品牌 ID(從 key 命名規則反推,見 auth.js 的 extractBrandFromKey),
//      擋掉「這組身份不能碰的品牌」的讀寫——不只是前端畫面藏起來,後端就真的不會回傳/不會給改。
//
// 共用設定類的 key(例如 meta-api-brands 品牌清單本身)不屬於任何單一品牌,這裡不擋,
// 但內容需要依身份過濾,那個邏輯放在 kv/item/[key].js 跟 kv/list.js 裡處理(因為要看實際內容才能過濾)。
import { resolveCredential, extractBrandFromKey, canAccessBrand } from "../../_shared/auth.js";

function targetKeyFromRequest(request) {
  const url = new URL(request.url);
  const itemMatch = url.pathname.match(/^\/api\/kv\/item\/(.+)$/);
  if (itemMatch) {
    try { return decodeURIComponent(itemMatch[1]); } catch { return itemMatch[1]; }
  }
  if (url.pathname === "/api/kv/list") return url.searchParams.get("prefix") || "";
  return null;
}

export async function onRequest({ request, env, next, data }) {
  let credential;
  if (env.TEAM_CREDENTIALS) {
    credential = resolveCredential(request, env);
    if (!credential) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    // 還沒設定 TEAM_CREDENTIALS 就退回舊的單一密碼(TEAM_SECRET)機制,行為跟這個功能還沒上線前一樣。
    const secret = env.TEAM_SECRET;
    if (secret) {
      const provided = request.headers.get("X-Team-Key") || "";
      if (provided !== secret) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    credential = { name: "", brands: "*" };
  }

  const targetKey = targetKeyFromRequest(request);
  if (targetKey) {
    const brandId = extractBrandFromKey(targetKey);
    if (brandId && !canAccessBrand(credential, brandId)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  data.credential = credential;
  return next();
}
