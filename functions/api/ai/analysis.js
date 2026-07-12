// POST /api/ai/analysis
// 改用 OpenAI(不是 Gemini/Vertex AI)——Gemini 那條路先後撞到 AI Studio 的 AQ. 金鑰格式問題
// (Google 那邊未解決的已知 bug)、又牽涉到 Google Cloud 專案/IAM 權限設定,太複雜。
// OpenAI 的 API Key 是單純的靜態金鑰(sk- 開頭),申請流程跟這邊呼叫方式都簡單很多。
//
// 回傳格式:{ insights: [...4條固定結構重點觀察], rowJudgments: { 代號: {icon, label} } }
// rowJudgments 是逐代號的短判斷(參考H&J週報「各品類投放結構」表格的判斷欄位風格),
// 前端拿來當「投放成效」表格裡新增的一欄,可以編輯。
//
// 需要在 Cloudflare Pages 專案設定 → 變數與機密 新增一個 Secret:
//   OPENAI_API_KEY = 去 platform.openai.com/api-keys 申請的金鑰(sk- 開頭)

const OPENAI_MODEL = "gpt-5.6-terra"; // 輕量/低成本款,這個任務不需要用到旗艦推理模型。

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

function buildPrompt({ brandName, periodLabel, roasTarget, totals, rows }) {
  const rowLines = rows
    .map((r) => `${r.code}:花費NT$${Math.round(r.spend).toLocaleString()}、業績NT$${Math.round(r.revenue).toLocaleString()}、ROAS ${r.roas !== null ? r.roas.toFixed(2) : "—"}x、成交${r.conversions}筆、花費佔比${r.spendShare.toFixed(1)}%`)
    .join("\n");
  return `你是電商廣告投放顧問,以下是「${brandName || "本品牌"}」${periodLabel ? `(${periodLabel})` : ""}的廣告成效數據,幫團隊寫重點觀察,語氣像在週會上直接口頭報告,不要客套話、不要重複數據本身,要給判斷跟建議。

整體:花費NT$${Math.round(totals.spend).toLocaleString()}、業績NT$${Math.round(totals.revenue).toLocaleString()}、整體ROAS ${totals.roas !== null ? totals.roas.toFixed(2) : "—"}x(目標${roasTarget}x)、成交${totals.conversions}筆

各系列:
${rowLines}

【第一部分:重點觀察】固定寫「剛好4條」,順序、角色都固定成這樣(對齊參考的週報格式),不要多也不要少:
1. 🏆 開頭:點名 ROAS 最高的系列,說明它花費/業績表現,給一個像「本週絕對黑馬」這種強烈評價。
2. 💪 開頭:整體 ROAS 對比目標倍數的達標評價(達標就正面肯定,沒達標就點出差距)。
3. ⚠️ 開頭:點名 ROAS 最低、或明顯落後其他系列的那個(如果全部都表現不錯,改成點出「相對最需要留意」的那個),給具體建議(控制預算/優化素材/停損等)。
4. 📌 開頭:點名花費佔比最高的系列,說明它是不是主要貢獻來源,評價是否合理。

每條文字精簡(每條30-50字內),不是逐條複述數字,是給出判斷。每條裡最關鍵的判斷/結論那幾個字,用 **文字** 包起來強調(例如「...是本週絕對黑馬」寫成「...是**本週絕對黑馬**」),不要整句都包,只包最核心那一小段。

【第二部分:逐代號判斷】針對「各系列」清單裡的每一個代號,各給一個簡短判斷(參考範例週報「各品類投放結構」表格的判斷欄位風格),格式是「emoji + 4到8字左右的短標籤」,例如「主力成交」「高效率」「有潛力,素材待加強」「成本偏高,需重做素材」——emoji 用 🟢(表現健康/可持續)、🟡(有疑慮但還行/待觀察)、🔴(明顯需要處理)三選一,不要用其他emoji,每個代號都要有,不能漏。

只回傳 JSON,格式:{"insights":[{"icon":"🏆","text":"..."},{"icon":"💪","text":"..."},{"icon":"⚠️","text":"..."},{"icon":"📌","text":"..."}],"rowJudgments":{"代號1":{"icon":"🟢","label":"..."},"代號2":{"icon":"🔴","label":"..."}}},insights剛好4個元素、順序就是1-4的順序,rowJudgments要包含上面列出的每一個代號,不要有其他文字。`;
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
  // 要求的是 {"insights":[...],"rowJudgments":{...}} 這個形狀,但保留萬一模型只回傳陣列的容錯
  // (退回沒有 rowJudgments 的狀態,前端那欄會是空的,不會整個功能壞掉)。
  const insights = Array.isArray(parsed) ? parsed : parsed.insights;
  const rowJudgments = Array.isArray(parsed) ? {} : (parsed.rowJudgments || {});
  if (!Array.isArray(insights)) return jsonResponse({ error: "OpenAI 回應格式不是陣列。" }, 502);

  return jsonResponse({ insights, rowJudgments });
}
