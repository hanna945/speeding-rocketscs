import { resolveCredential } from "../../_shared/auth.js";

const OWNER = "hanna945";
const REPO = "speeding-rocketscs";
const WORKFLOW = "airbyte-meta-sync.yml";
const API_BASE = "https://api.github.com";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function requireCredential(request, env) {
  if (!env.TEAM_CREDENTIALS) {
    return { error: json({ ok: false, error: "team_credentials_not_configured" }, 503) };
  }
  const credential = resolveCredential(request, env);
  if (!credential) {
    return { error: json({ ok: false, error: "unauthorized" }, 401) };
  }
  return { credential };
}

function workflowToken(env) {
  return String(env.GITHUB_WORKFLOW_TOKEN || "").trim();
}

async function githubRequest(env, path, options = {}) {
  const token = workflowToken(env);
  if (!token) {
    throw new Error("github_workflow_token_not_configured");
  }
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "speedingscs-airbyte-manual-sync/1.0",
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = body && body.message ? body.message : String(body || response.status);
    throw new Error("github_api_" + response.status + ":" + detail);
  }
  return body;
}

function normalizeRequestId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export async function onRequestPost({ request, env }) {
  const auth = requireCredential(request, env);
  if (auth.error) return auth.error;

  let body = {};
  try { body = await request.json(); } catch {}

  const requestId = normalizeRequestId(body.requestId) || ("manual-" + Date.now());
  try {
    await githubRequest(
      env,
      "/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + encodeURIComponent(WORKFLOW) + "/dispatches",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            brand_id: "",
            backfill_days: "0",
            engine: "airbyte",
            request_id: requestId,
          },
        }),
      }
    );
    return json({
      ok: true,
      status: "queued",
      requestId,
      message: "Airbyte 全品牌同步已啟動",
    }, 202);
  } catch (error) {
    const message = String(error && error.message || error);
    if (message.includes("github_workflow_token_not_configured")) {
      return json({
        ok: false,
        error: "github_workflow_token_not_configured",
        message: "Cloudflare 尚未設定 GITHUB_WORKFLOW_TOKEN",
      }, 503);
    }
    return json({ ok: false, error: "dispatch_failed", message }, 502);
  }
}

export async function onRequestGet({ request, env }) {
  const auth = requireCredential(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const requestId = normalizeRequestId(url.searchParams.get("request_id"));
  if (!requestId) {
    return json({ ok: false, error: "missing_request_id" }, 400);
  }

  try {
    const payload = await githubRequest(
      env,
      "/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + encodeURIComponent(WORKFLOW) + "/runs?event=workflow_dispatch&per_page=20"
    );
    const runs = Array.isArray(payload && payload.workflow_runs) ? payload.workflow_runs : [];
    const run = runs.find((item) => String(item.display_title || "").includes(requestId));
    if (!run) {
      return json({ ok: true, found: false, requestId, status: "queued" });
    }
    return json({
      ok: true,
      found: true,
      requestId,
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion || null,
      startedAt: run.run_started_at || run.created_at || null,
      updatedAt: run.updated_at || null,
      htmlUrl: run.html_url || null,
    });
  } catch (error) {
    const message = String(error && error.message || error);
    if (message.includes("github_workflow_token_not_configured")) {
      return json({
        ok: false,
        error: "github_workflow_token_not_configured",
        message: "Cloudflare 尚未設定 GITHUB_WORKFLOW_TOKEN",
      }, 503);
    }
    return json({ ok: false, error: "status_failed", message }, 502);
  }
}
