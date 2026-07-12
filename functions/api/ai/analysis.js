// POST /api/ai/analysis
// 改用 OpenAI(不是 Gemini/Vertex AI)——Gemini 那條路先後撞到 AI Studio 的 AQ. 金鑰格式問題
// (Google 那邊未解決的已知 bug)、又牽涉到 Google Cloud 專案/IAM 權限設定,太複雜。
// OpenAI 的 API Key 是單純的靜態金鑰(sk- 開頭),申請流程跟這邊呼叫方式都簡單很多。
//
// 回傳格式維持跟規則統計版一樣(JSON 陣列,每條 {icon, text}),前端渲染邏輯不用動。
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

寫4到6條重點觀察,每條開頭挑一個最貼切的emoji(🏆表現最突出、⚠️需要留意或表現下滑、📌值得標注的事實或建議、💪整體達標值得鼓舞),文字精簡(每條30-50字內),直接點出誰表現最好/最差、有沒有異常花費、有沒有值得加碼或該控制預算的地方——不是逐條複述數字,是給出判斷。

只回傳 JSON,格式:{"insights":[{"icon":"🏆","text":"..."}]},不要有其他文字。`;
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
  // 要求的是 {"insights":[...]} 這個形狀(OpenAI 的 json_object 模式要求最外層一定是物件,不能直接是陣列),
  // 但保留萬一模型還是直接回傳陣列的容錯。
  const insights = Array.isArray(parsed) ? parsed : parsed.insights;
  if (!Array.isArray(insights)) return jsonResponse({ error: "OpenAI 回應格式不是陣列。" }, 502);

  return jsonResponse({ insights });
}
