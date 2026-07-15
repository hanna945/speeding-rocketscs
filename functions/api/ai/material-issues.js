// POST /api/ai/material-issues
// 跟 analysis.js 同一套模式(同一支OpenAI金鑰、同一個輕量模型),只是產出的目標不一樣:
// analysis.js 是「整體週報重點觀察」,這支是「週報告」裡兩個子區塊要用的——
// 「下週操作方向」(宏觀策略建議)+「素材調整方向」(挑出表現有疑慮的系列,寫成
// Hanna提供的範例格式:標題+數據佐證+條列問題點/建議方向,category統一用產品代號本身)。
// 兩個子區塊各自的AI按鈕都打這同一支API、拿同一份回應——同一份數據沒必要打兩次OpenAI,
// 檔名維持 material-issues 沒有改(避免多一次改檔名連帶要改前端fetch路徑的風險),
// 但回應格式已經是 {actionItems, materialIssues} 兩個陣列都有。
//
// 這支只負責「生成建議」,不負責寫入KV——寫入是前端收到回應後,自己 append 進使用者當下
// 那份「週報告」資料裡再存檔,AI只負責產生內容草稿,使用者仍然可以編輯/刪除每一筆。

const OPENAI_MODEL = "gpt-5.6-terra";

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

function buildPrompt({ brandName, periodLabel, roasTarget, totals, rows }) {
  const rowLines = rows
    .map((r) => `${r.code}:花費NT$${Math.round(r.spend).toLocaleString()}、業績NT$${Math.round(r.revenue).toLocaleString()}、ROAS ${r.roas !== null ? r.roas.toFixed(2) : "—"}x、成交${r.conversions}筆、花費佔比${r.spendShare.toFixed(1)}%`)
    .join("\n");
  return `你是電商廣告投放顧問,以下是「${brandName || "本品牌"}」${periodLabel ? `(${periodLabel})` : ""}的廣告成效數據,目標ROAS是${roasTarget}x,要幫團隊準備下一期的週報告草稿,分成兩個部分。

整體:花費NT$${Math.round(totals.spend).toLocaleString()}、業績NT$${Math.round(totals.revenue).toLocaleString()}、整體ROAS ${totals.roas !== null ? totals.roas.toFixed(2) : "—"}x
各系列:
${rowLines}

【第一部分:下一期操作方向】3-4條,是給整體策略方向的建議(不是針對單一系列挑毛病,是像「預算該往哪裡移」「該守住什麼目標」這種宏觀判斷),每條結構:
- title:一句精簡標題,例如「預算優先轉往價值型」「SR先做素材汰換,不加總預算」。
- description:1-2句說明為什麼、具體怎麼做。
語氣像團隊會議上直接講重點,不是寫報告。

【第二部分:值得下一期特別調整的系列】從各系列裡挑出「表現有疑慮」的,最多3個,沒有明顯問題就可以少於3個甚至0個(不要為了湊數硬挑健康的系列)。挑選標準例如:花費金額大但ROAS明顯低於目標、跟同類型系列比起來效率明顯落後、成交量小卻花費不低。每個結構:
- title:一句話標題,點出問題,例如「SR涼感衣吃掉最大預算，但CPA偏高」——不是重複數據,是給判斷。
- status:嚴重程度,"red"(明顯需要處理)、"yellow"(有風險、待觀察)二選一。
- category:就是這個系列的代號本身(例如"SR"),不要加其他文字。
- content:2-4句,先用一句話帶數據佐證問題(例如金額、ROAS、成交數),接著條列1-3個具體建議方向或該檢查的問題(每條用「・」開頭,換行分隔)。

只回傳 JSON,格式:{"actionItems":[{"title":"...","description":"..."}],"materialIssues":[{"title":"...","status":"red","category":"SR","content":"..."}]},第二部分沒有值得挑的系列就回傳空陣列,不要有其他文字。`;
}

export async function onRequestPost({ request, env }) {
  if (!env.OPENAI_API_KEY) return jsonResponse({ error: "尚未設定 OPENAI_API_KEY。" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "請求格式不是合法 JSON。" }, 400);
  }
  const { brandName, periodLabel, roasTarget, totals, rows } = body || {};
  if (!totals || !Array.isArray(rows) || !rows.length) {
    return jsonResponse({ error: "缺少 totals 或 rows,無法產生分析。" }, 400);
  }

  const prompt = buildPrompt({ brandName, periodLabel, roasTarget: roasTarget || 3, totals, rows });

  let openaiRes;
  try {
    openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
  } catch (e) {
    return jsonResponse({ error: "呼叫 OpenAI API 網路請求失敗:" + e.message }, 502);
  }

  const openaiJson = await openaiRes.json().catch(() => null);
  if (!openaiRes.ok || !openaiJson) {
    const msg = (openaiJson && openaiJson.error && openaiJson.error.message) || `HTTP ${openaiRes.status}`;
    return jsonResponse({ error: "OpenAI API 回應錯誤:" + msg }, 502);
  }

  const rawText = (openaiJson.choices && openaiJson.choices[0] && openaiJson.choices[0].message && openaiJson.choices[0].message.content) || "";
  if (!rawText.trim()) return jsonResponse({ error: "OpenAI 沒有回傳任何內容。" }, 502);

  const cleaned = rawText.replace(/^```json\s*|^```\s*|```$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return jsonResponse({ error: "OpenAI 回應不是合法 JSON,原始內容:" + cleaned.slice(0, 300) }, 502);
  }
  const actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
  const materialIssues = Array.isArray(parsed.materialIssues) ? parsed.materialIssues : [];
  if (!Array.isArray(parsed.actionItems) && !Array.isArray(parsed.materialIssues)) {
    return jsonResponse({ error: "OpenAI 回應格式不符合預期。" }, 502);
  }

  return jsonResponse({ actionItems, materialIssues });
}
