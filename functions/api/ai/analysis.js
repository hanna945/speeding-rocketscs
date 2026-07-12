// POST /api/ai/analysis
// 用 Gemini API 針對這期的廣告成效數據寫重點觀察,取代原本規則統計產生的「自動摘要重點」。
// 回傳格式刻意跟原本規則版一樣(JSON 陣列,每條 {icon, text}),前端不用另外改渲染邏輯,
// 兩種來源可以無縫替換——沒有 GEMINI_API_KEY 或呼叫失敗時,前端會自動退回規則版,不會整個報表壞掉。
//
// 需要在 Cloudflare Pages 專案設定 → 變數與機密 加一個 Secret:GEMINI_API_KEY。
//
// 呼叫方式(需要帶 X-Team-Key 驗證,跟 /api/sheets 同一組):
//   POST /api/ai/analysis
//   body: { brandName, periodLabel, roasTarget, totals: {spend,revenue,conversions,roas}, rows: [{code,spend,revenue,roas,conversions,spendShare}] }

const GEMINI_MODEL = "gemini-3.5-flash";

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

只回傳 JSON 陣列,格式範例:[{"icon":"🏆","text":"..."}],不要包在 markdown 程式碼區塊裡,不要有其他文字。`;
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) return jsonResponse({ error: "尚未設定 GEMINI_API_KEY。" }, 500);

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

  let geminiRes;
  try {
    geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  } catch (e) {
    return jsonResponse({ error: "呼叫 Gemini API 網路請求失敗:" + e.message }, 502);
  }

  const geminiJson = await geminiRes.json().catch(() => null);
  if (!geminiRes.ok || !geminiJson) {
    const msg = (geminiJson && geminiJson.error && geminiJson.error.message) || `HTTP ${geminiRes.status}`;
    return jsonResponse({ error: "Gemini API 回應錯誤:" + msg }, 502);
  }

  const rawText = ((geminiJson.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!rawText) return jsonResponse({ error: "Gemini 沒有回傳任何內容(可能被安全設定擋下)。" }, 502);

  // Gemini 偶爾還是會包一層 ```json ... ``` 或前後多打幾個字,這裡盡量寬容地把純 JSON 陣列部分抓出來。
  const cleaned = rawText.replace(/^```json\s*|^```\s*|```$/g, "").trim();
  let insights;
  try {
    insights = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        insights = JSON.parse(match[0]);
      } catch {
        return jsonResponse({ error: "Gemini 回應不是合法 JSON,原始內容:" + cleaned.slice(0, 300) }, 502);
      }
    } else {
      return jsonResponse({ error: "Gemini 回應不是合法 JSON,原始內容:" + cleaned.slice(0, 300) }, 502);
    }
  }
  if (!Array.isArray(insights)) return jsonResponse({ error: "Gemini 回應格式不是陣列。" }, 502);

  return jsonResponse({ insights });
}
