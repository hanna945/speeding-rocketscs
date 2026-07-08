// GET /api/kv/list?prefix=xxx
// 對應前端的 storage.list(prefix),列出所有符合前綴的 key。
//
// 品牌範圍受限的身份(brands 是陣列,不是 "*"):結果會先過濾掉不屬於自己權限的品牌 key,
// 避免像 probeCloud 那種「用空字串當 prefix 撈全部」的呼叫方式,讓看不到資料內容、
// 但還是能從 key 名稱本身看到其他品牌的廣告帳號 ID、有哪些月份在動。
//
// 回傳內容額外帶一個 credentialName,讓前端可以顯示「目前是用哪組身份登入」,不用另外呼叫別支 API。
import { extractBrandFromKey, canAccessBrand } from "../../_shared/auth.js";

export async function onRequestGet({ request, env, data }) {
  const credential = data.credential;
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || "";
  const list = await env.REPORT_KV.list({ prefix, limit: 1000 });
  const keys = list.keys
    .map((k) => k.name)
    .filter((name) => {
      const brandId = extractBrandFromKey(name);
      return !brandId || canAccessBrand(credential, brandId);
    });
  return new Response(
    JSON.stringify({
      keys,
      credentialName: credential ? credential.name : "",
      credentialBrands: credential && credential.roster ? credential.roster : null,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
