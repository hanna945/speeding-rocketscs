// GET /api/kv/item/:key     -> 對應前端 storage.get(key)
// PUT /api/kv/item/:key     -> 對應前端 storage.set(key, value),body 是純文字(JSON字串)
// DELETE /api/kv/item/:key  -> 對應前端 storage.delete(key)
// key 在前端已經先用 encodeURIComponent 編碼過,這裡要記得 decode 回來。
//
// 這幾個 key 是「全部品牌共用一份」的清單/設定,依形狀分兩類:
//   - meta-api-brands:陣列,每一項是 {id, name}(品牌清單本身)
//   - meta-api-cpa-thresholds、meta-api-adratio-thresholds:物件,key 是品牌 ID(CPA / 廣告費佔比 過高門檻,兩個存法一致)
// 品牌範圍受限的身份(brands 是陣列,不是 "*")存取時:
//   - GET:只回傳自己權限內的品牌,不會看到其他部門的品牌名稱/ID/門檻設定。
//   - PUT:只會「合併」進自己權限內的品牌資料,不會動到其他部門的品牌(因為這種身份的前端本來就只看得到
//     自己那幾個品牌,送上來的內容原本就不包含別人的,這裡再保守地用「先移除自己權限內的舊資料、
//     再放進新資料」的方式合併,即使前端邏輯以後改了也不會不小心把其他部門的資料整批覆蓋掉)。
// 其餘依品牌 ID 命名的 key(月報表/週報表/帳本),能不能碰在上一層 _middleware.js 已經擋過了,這裡不用重複判斷。

const BRAND_LIST_KEY = "meta-api-brands"; // 陣列形狀
const BRAND_KEYED_OBJECT_KEYS = new Set(["meta-api-cpa-thresholds", "meta-api-adratio-thresholds"]); // 物件形狀,key 是品牌 ID
const SHARED_LIST_KEYS = new Set([BRAND_LIST_KEY, ...BRAND_KEYED_OBJECT_KEYS]);

function filterSharedValue(key, rawValue, credential) {
  if (credential.brands === "*") return rawValue;
  let parsed;
  try { parsed = JSON.parse(rawValue); } catch { return rawValue; }
  if (key === BRAND_LIST_KEY && Array.isArray(parsed)) {
    return JSON.stringify(parsed.filter((b) => b && credential.brands.includes(b.id)));
  }
  if (BRAND_KEYED_OBJECT_KEYS.has(key) && parsed && typeof parsed === "object") {
    const filtered = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (credential.brands.includes(id)) filtered[id] = v;
    }
    return JSON.stringify(filtered);
  }
  return rawValue;
}

// 範圍受限的身份寫入共用清單時,把「既有資料裡不屬於自己權限的部分」跟「這次送上來、屬於自己權限的部分」合併,
// 確保其他部門的品牌/門檻設定不會被覆蓋或刪除掉。
async function mergeScopedWrite(env, key, incomingRaw, credential) {
  const existingRaw = await env.REPORT_KV.get(key);
  let incoming;
  try { incoming = JSON.parse(incomingRaw); } catch { return incomingRaw; }
  let existing = [];
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw); } catch { existing = []; }
  }

  if (key === BRAND_LIST_KEY) {
    const existingArr = Array.isArray(existing) ? existing : [];
    const incomingArr = Array.isArray(incoming) ? incoming : [];
    const outsideScope = existingArr.filter((b) => !b || !credential.brands.includes(b.id));
    const withinScope = incomingArr.filter((b) => b && credential.brands.includes(b.id));
    return JSON.stringify([...outsideScope, ...withinScope]);
  }
  if (BRAND_KEYED_OBJECT_KEYS.has(key)) {
    const existingObj = existing && typeof existing === "object" ? existing : {};
    const incomingObj = incoming && typeof incoming === "object" ? incoming : {};
    const merged = {};
    for (const [id, v] of Object.entries(existingObj)) {
      if (!credential.brands.includes(id)) merged[id] = v;
    }
    for (const [id, v] of Object.entries(incomingObj)) {
      if (credential.brands.includes(id)) merged[id] = v;
    }
    return JSON.stringify(merged);
  }
  return incomingRaw;
}

export async function onRequestGet({ params, env, data }) {
  const key = decodeURIComponent(params.key);
  const value = await env.REPORT_KV.get(key);
  if (value === null) {
    return new Response(JSON.stringify(null), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const outValue = SHARED_LIST_KEYS.has(key) ? filterSharedValue(key, value, data.credential) : value;
  return new Response(JSON.stringify({ key, value: outValue }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPut({ params, env, request, data }) {
  const key = decodeURIComponent(params.key);
  let value = await request.text();
  if (SHARED_LIST_KEYS.has(key) && data.credential.brands !== "*") {
    value = await mergeScopedWrite(env, key, value, data.credential);
  }
  await env.REPORT_KV.put(key, value);
  return new Response(JSON.stringify({ key, value }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestDelete({ params, env, data }) {
  const key = decodeURIComponent(params.key);
  if (SHARED_LIST_KEYS.has(key) && data.credential.brands !== "*") {
    // 範圍受限的身份「刪除」共用清單,語意上等同「把自己權限內的部分清空」,一樣用合併邏輯處理(送一個空陣列/物件進去合併)。
    const emptyValue = key === BRAND_LIST_KEY ? "[]" : "{}";
    const merged = await mergeScopedWrite(env, key, emptyValue, data.credential);
    await env.REPORT_KV.put(key, merged);
    return new Response(JSON.stringify({ key, deleted: true }), { headers: { "Content-Type": "application/json" } });
  }
  await env.REPORT_KV.delete(key);
  return new Response(JSON.stringify({ key, deleted: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
