// POST /api/ai/analysis
// 改用 Vertex AI(不是 AI Studio 的 Gemini API)——原本用 GEMINI_API_KEY(AI Studio 核發的 AQ. 格式金鑰)
// 在 Google 那邊撞到一個目前還沒解決的已知 bug(官方論壇上有多筆一模一樣的錯誤回報:
// "Expected OAuth 2 access token"),換一條路,直接沿用讀 Google Sheet 那把服務帳號金鑰
// (GOOGLE_SERVICE_ACCOUNT_KEY,已經在用、穩定),用 OAuth2 換 access token 打 Vertex AI,
// 不再需要另外申請/維護一組 AI Studio 金鑰。
//
// 回傳格式維持跟規則統計版一樣(JSON 陣列,每條 {icon, text}),前端渲染邏輯不用動。
//
// 需要在 Cloudflare Pages 專案設定 → 變數與機密 額外加一個(不用是 Secret,一般變數即可):
//   GOOGLE_CLOUD_PROJECT_ID = 這把服務帳號所屬的 Google Cloud 專案 ID
// GOOGLE_SERVICE_ACCOUNT_KEY 沿用現有的(讀 Sheet 那把),但這把服務帳號的 Google Cloud 專案
// 需要額外「啟用 Vertex AI API」,並且這個服務帳號要有 Vertex AI 的存取權限(角色:Vertex AI User)。

import { getGoogleAccessToken } from "../../_shared/googleAuth.js";

const VERTEX_MODEL = "gemini-3.5-flash";
const VERTEX_LOCATION = "global";

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
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) return jsonResponse({ error: "尚未設定 GOOGLE_SERVICE_ACCOUNT_KEY。" }, 500);
  if (!env.GOOGLE_CLOUD_PROJECT_ID) return jsonResponse({ error: "尚未設定 GOOGLE_CLOUD_PROJECT_ID。" }, 500);

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

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    return jsonResponse({ error: "GOOGLE_SERVICE_ACCOUNT_KEY 不是合法的 JSON。" }, 500);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount, "https://www.googleapis.com/auth/cloud-platform");
  } catch (e) {
    return jsonResponse({ error: "跟 Google 驗證失敗:" + e.message }, 502);
  }

  const prompt = buildPrompt({ brandName, periodLabel, roasTarget: roasTarget || 3, totals, rows });
  const url = `https://aiplatform.googleapis.com/v1/projects/${env.GOOGLE_CLOUD_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;

  let vertexRes;
  try {
    vertexRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
  } catch (e) {
    return jsonResponse({ error: "呼叫 Vertex AI 網路請求失敗:" + e.message }, 502);
  }

  const vertexJson = await vertexRes.json().catch(() => null);
  if (!vertexRes.ok || !vertexJson) {
    const msg = (vertexJson && vertexJson.error && vertexJson.error.message) || `HTTP ${vertexRes.status}`;
    return jsonResponse({ error: "Vertex AI 回應錯誤:" + msg }, 502);
  }

  const rawText = ((vertexJson.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!rawText) return jsonResponse({ error: "Vertex AI 沒有回傳任何內容(可能被安全設定擋下)。" }, 502);

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
        return jsonResponse({ error: "Vertex AI 回應不是合法 JSON,原始內容:" + cleaned.slice(0, 300) }, 502);
      }
    } else {
      return jsonResponse({ error: "Vertex AI 回應不是合法 JSON,原始內容:" + cleaned.slice(0, 300) }, 502);
    }
  }
  if (!Array.isArray(insights)) return jsonResponse({ error: "Vertex AI 回應格式不是陣列。" }, 502);

  return jsonResponse({ insights });
}
