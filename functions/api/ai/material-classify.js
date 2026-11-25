// POST /api/ai/material-classify
// 以廣告縮圖為主要依據，廣告名稱/活動名稱只做輔助，將素材歸到固定類型。
const OPENAI_MODEL = "gpt-5.6-terra";
const CATEGORIES = ["人像素材","情境素材","產品素材","口播／實測","UGC／KOC／業配","圖文／促銷","無法判斷"];
const IMG_PROXY_BASE = "https://shopline-proxy.hanna-104.workers.dev";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function cleanText(v, n = 180) { return String(v || "").replace(/[\r\n]+/g, " ").slice(0, n); }
function publicImage(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return "";
  if (/fbcdn\.net|facebook\.com/i.test(value)) return IMG_PROXY_BASE + "/api/img?u=" + encodeURIComponent(value);
  return value;
}
function parseJsonText(text) {
  const cleaned = String(text || "").replace(/^\`\`\`json\s*|^\`\`\`\s*|\`\`\`$/g, "").trim();
  return JSON.parse(cleaned);
}
async function classifyChunk(env, items) {
  const content = [{
    type: "text",
    text:
      "你是電商廣告素材分類器。最重要的判斷依據是每支廣告提供的縮圖，名稱與活動名稱只能輔助，不可蓋過畫面。"+
      "每支只能選一個主類型："+CATEGORIES.join("、")+"。"+
      "定義：人像素材=人物是畫面主體；情境素材=生活/戶外/居家等使用情境是主體；產品素材=商品/材質/細節本身是主體；"+
      "口播／實測=縮圖明顯呈現真人講解、測試、功能示範；UGC／KOC／業配=素人/KOC/KOL分享或業配感；"+
      "圖文／促銷=價格、優惠、文字版面、BN/促銷資訊為主；看不清楚或沒有縮圖就選無法判斷。"+
      "回傳純JSON：{\"results\":[{\"adId\":\"...\",\"category\":\"...\",\"confidence\":0到1,\"reason\":\"15字內\"}]}。"
  }];
  for (const item of items) {
    content.push({ type: "text", text: "AD "+item.adId+"｜名稱："+cleanText(item.name)+"｜活動："+cleanText(item.campaign) });
    const image = publicImage(item.image);
    if (image) content.push({ type: "image_url", image_url: { url: image, detail: "low" } });
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.OPENAI_API_KEY },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error((body && body.error && body.error.message) || ("HTTP " + res.status));
  const raw = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  const parsed = parseJsonText(raw);
  return Array.isArray(parsed.results) ? parsed.results : [];
}

export async function onRequestPost({ request, env }) {
  if (!env.OPENAI_API_KEY) return json({ error: "尚未設定 OPENAI_API_KEY" }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, 400); }
  const source = Array.isArray(body && body.items) ? body.items : [];
  const items = source.slice(0, 80).map((x) => ({
    adId: cleanText(x && x.adId, 80),
    name: cleanText(x && x.name),
    campaign: cleanText(x && x.campaign),
    image: String(x && x.image || "").trim(),
  })).filter((x) => x.adId);
  if (!items.length) return json({ results: [] });

  const results = [];
  try {
    for (let i = 0; i < items.length; i += 12) {
      const part = await classifyChunk(env, items.slice(i, i + 12));
      for (const row of part) {
        const adId = cleanText(row && row.adId, 80);
        const category = CATEGORIES.includes(row && row.category) ? row.category : "無法判斷";
        if (!adId) continue;
        results.push({
          adId,
          category,
          confidence: Math.max(0, Math.min(1, Number(row && row.confidence) || 0)),
          reason: cleanText(row && row.reason, 80),
        });
      }
    }
  } catch (e) {
    return json({ error: "素材分類失敗：" + e.message }, 502);
  }
  const seen = new Set(results.map((x) => x.adId));
  for (const item of items) if (!seen.has(item.adId)) results.push({ adId: item.adId, category: "無法判斷", confidence: 0, reason: "未取得分類" });
  return json({ results, categories: CATEGORIES });
}
