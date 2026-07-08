// 跟 /api/kv 用同一組登入身份機制(TEAM_CREDENTIALS)。
// 驗證通過後,把解析出來的身份(data.credential = { name, brands })往下傳給實際的 handler,
// 讓 sync.js / auto.js 可以判斷這個身份能不能動某個 accountId。
import { resolveCredential } from "../../_shared/auth.js";

export async function onRequest({ request, env, next, data }) {
  if (env.TEAM_CREDENTIALS) {
    const credential = resolveCredential(request, env);
    if (!credential) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    data.credential = credential;
    return next();
  }

  // 還沒設定 TEAM_CREDENTIALS 就退回舊的單一密碼(TEAM_SECRET)機制,行為跟這個功能還沒上線前一樣。
  const secret = env.TEAM_SECRET;
  if (secret) {
    const provided = request.headers.get("X-Team-Key") || "";
    if (provided !== secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  data.credential = { name: "", brands: "*" };
  return next();
}
