// 用 Google 服務帳號的 JSON 金鑰簽一個 JWT,跟 Google 換一個一小時有效的 access token。
// 只用 Cloudflare Workers 原生支援的 Web Crypto API(crypto.subtle),不需要額外安裝套件。
// 這份試算表完全不用公開分享——只要分享給服務帳號的 email 就好,對外連結依然是私密的。

function base64urlFromString(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlFromBytes(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function importPrivateKey(pem) {
  const keyData = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// serviceAccount:直接是從 Google Cloud 下載的 JSON 金鑰檔內容(物件),
// 至少要有 client_email 跟 private_key 這兩個欄位。
// scope 預設只要「唯讀」權限,不要求寫入,就算金鑰外洩,對方也頂多能看、不能改你的試算表。
export async function getGoogleAccessToken(serviceAccount, scope = "https://www.googleapis.com/auth/spreadsheets.readonly") {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64urlFromBytes(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error("跟 Google 換 access token 失敗:" + (json.error_description || json.error || res.status));
  }
  return json.access_token;
}

// Google Sheets(以及 Excel 預設的 1900 日期系統)以 1899-12-30 為序列值第 0 天,
// 跟現有 xlsx 匯入邏輯用 cellDates:true 轉出來的邏輯一致,確保跟既有的 parseLedgerSheet() 相容。
export function serialToDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
}

// 把 Sheets API 回傳的 values(二維陣列,長短不一、缺的儲存格會直接省略,不會補 null)
// 轉成 parseLedgerSheet() 預期的 matrix 格式:每列補齊到同樣寬度、第 0 欄如果是數字(日期序列值)轉成真正的 Date 物件。
export function sheetsValuesToMatrix(values) {
  const width = Math.max(0, ...values.map((r) => r.length));
  return values.map((row, rIdx) => {
    const padded = Array.from({ length: width }, (_, i) => (row[i] === undefined ? null : row[i]));
    if (rIdx >= 2 && typeof padded[0] === "number") padded[0] = serialToDate(padded[0]);
    return padded;
  });
}

export async function fetchSheetMonthValues(accessToken, sheetId, tabName) {
  // 原本寫死 A1:BZ400,隨著不斷新增產品代號,欄位遲早會超出這個邊界,超出的部分從 API 這一步
  // 就抓不到,不是解析邏輯的問題。改成只給分頁名稱、不給儲存格範圍——Google Sheets API 的行為是
  // 這樣就會回傳整個分頁「目前有資料」的範圍,之後不管加多少產品代號都不會再卡到同樣的問題。
  const range = encodeURIComponent(tabName);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`讀取 Google Sheet「${tabName}」分頁失敗:${json.error && json.error.message}`);
  return json.values || [];
}
