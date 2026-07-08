// 解析 X-Team-Key 對應到哪一組登入身份(顯示名稱 + 能看哪些品牌的廣告帳號 ID)。
//
// TEAM_CREDENTIALS 存在 Cloudflare 的環境變數(型別選 Secret),JSON 格式,例如:
// {
//   "C8888": { "name": "品牌C部", "brands": ["1818692121940743", "2345685238995965", "2157995930925784"] },
//   "TEST888": { "name": "測試", "brands": "*" }
// }
// brands 填 "*" 代表最高權限,能看全部品牌,包含以後新增的;填陣列則只能看列出來的那幾個廣告帳號 ID。
//
// 想要新增品牌、換密碼、調整某組密碼能看哪些品牌,都直接改這個環境變數的值再重新部署即可,不需要改程式碼。
//
// 為了不要一次改壞正在使用中的網站,如果完全沒有設定 TEAM_CREDENTIALS,就退回「沒有密碼保護,全部放行」
// (等同這個功能還沒啟用之前的狀態)。

export function resolveCredential(request, env) {
  if (!env.TEAM_CREDENTIALS) return null;
  let creds;
  try {
    creds = JSON.parse(env.TEAM_CREDENTIALS);
  } catch {
    return null;
  }
  const key = request.headers.get("X-Team-Key") || "";
  if (!key || !creds[key]) return null;
  const entry = creds[key] || {};
  const brands = entry.brands === "*" ? "*" : (Array.isArray(entry.brands) ? entry.brands : []);
  return { name: entry.name || "", brands };
}

// 依 KV key 的命名規則(見 index.html 的 monthKeyFor / weekKeyFor / ledgerKeyFor)反推這個 key 屬於哪個品牌。
// 格式："{prefix}{brandId}::{其餘部分}",例如 "metaads-month:2157995930925784::2026-06"。
// 另外 sheet-map、last-sync-date 這兩種 key 沒有 "::",整段前綴之後就是完整的 accountId。
// 回傳 null 代表這個 key 不屬於任何特定品牌(共用設定類的 key,例如 meta-api-brands)。
const BRAND_SCOPED_DOUBLE_COLON_PREFIXES = ["metaads-month:", "metaads-week:", "metaads-ledger:"];
const BRAND_SCOPED_DIRECT_PREFIXES = ["sheet-map:", "last-sync-date:"];

export function extractBrandFromKey(key) {
  if (!key) return null;
  for (const prefix of BRAND_SCOPED_DOUBLE_COLON_PREFIXES) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      const idx = rest.indexOf("::");
      return idx >= 0 ? rest.slice(0, idx) : null;
    }
  }
  for (const prefix of BRAND_SCOPED_DIRECT_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

// credential.brands === "*" 全部放行;否則必須明確列在允許清單裡。
// brandId 是 null(共用 key)的情況不在這裡判斷,由呼叫端另外處理(通常是「讀取時過濾內容」而不是整個擋掉)。
export function canAccessBrand(credential, brandId) {
  if (!credential) return false;
  if (credential.brands === "*") return true;
  if (brandId === null) return true;
  return credential.brands.includes(brandId);
}
