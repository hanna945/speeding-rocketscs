// 跟 /api/sheets、/api/kv 用同一組登入身份機制(TEAM_CREDENTIALS)——複製那份邏輯,
// 不共用同一個檔案是因為 Cloudflare Pages Functions 的 _middleware.js 是按資料夾各自套用的,
// 沒有簡單的「跨資料夾共用一份」機制,只能各自放一份(跟 ledgerParser.js 在三個 repo 各放一份是同樣的限制)。
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
