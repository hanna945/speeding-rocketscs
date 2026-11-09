import { resolveCredential } from "../../_shared/auth.js";
import { verifyGitHubActionsOidc } from "../../_shared/githubOidc.js";

const PENDING_KEYS = {
  full: "airbyte-manual-sync-pending",
  thumbnails: "meta-thumbnail-repair-pending",
};

function pendingKey(mode) {
  return mode === "thumbnails" ? PENDING_KEYS.thumbnails : PENDING_KEYS.full;
}
const STATUS_PREFIX = "airbyte-manual-sync-status:";
const STATUS_TTL_SECONDS = 24 * 60 * 60;
const PENDING_TTL_SECONDS = 2 * 60 * 60;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeRequestId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function statusKey(requestId) {
  return STATUS_PREFIX + requestId;
}

async function readJson(env, key) {
  const raw = await env.REPORT_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeStatus(env, requestId, patch) {
  const key = statusKey(requestId);
  const current = await readJson(env, key) || {};
  const next = {
    requestId,
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await env.REPORT_KV.put(key, JSON.stringify(next), { expirationTtl: STATUS_TTL_SECONDS });
  return next;
}

function browserCredential(request, env) {
  if (!env.TEAM_CREDENTIALS) return null;
  return resolveCredential(request, env);
}

async function machineClaims(request) {
  return verifyGitHubActionsOidc(request);
}

export async function onRequestPost({ request, env }) {
  const claims = await machineClaims(request);
  if (claims) {
    let body = {};
    try { body = await request.json(); } catch {}
    const action = String(body.action || "");
    const requestId = normalizeRequestId(body.requestId);
    if (!requestId) return json({ ok: false, error: "missing_request_id" }, 400);

    if (action === "claim") {
      let pending = null;
      let mode = "full";
      for (const candidateMode of ["thumbnails", "full"]) {
        const candidate = await readJson(env, pendingKey(candidateMode));
        if (candidate && candidate.requestId === requestId) {
          pending = candidate;
          mode = candidateMode;
          break;
        }
      }
      if (!pending) {
        return json({ ok: false, error: "request_not_pending" }, 409);
      }
      const status = await writeStatus(env, requestId, {
        status: "running",
        conclusion: null,
        mode,
        startedAt: new Date().toISOString(),
        htmlUrl: body.htmlUrl || null,
        message: mode === "thumbnails"
          ? "GitHub Actions 已接手，準備修復素材縮圖"
          : "GitHub Actions 已接手，Airbyte 準備同步",
      });
      return json({ ok: true, ...status });
    }

    if (action === "progress") {
      const rawBrands = Array.isArray(body.brands) ? body.brands : [];
      const brands = rawBrands.slice(0, 100).map((item) => ({
        id: String(item && item.id || "").slice(0, 64),
        name: String(item && item.name || "").slice(0, 120),
        status: ["waiting", "running", "done", "error"].includes(String(item && item.status || ""))
          ? String(item.status)
          : "waiting",
        message: String(item && item.message || "").slice(0, 300),
      }));
      const completed = Number.isFinite(Number(body.completed)) ? Number(body.completed) : brands.filter((b) => b.status === "done").length;
      const total = Number.isFinite(Number(body.total)) ? Number(body.total) : brands.length;
      const currentBrand = body.currentBrand && typeof body.currentBrand === "object"
        ? {
            id: String(body.currentBrand.id || "").slice(0, 64),
            name: String(body.currentBrand.name || "").slice(0, 120),
          }
        : null;
      const status = await writeStatus(env, requestId, {
        status: "running",
        conclusion: null,
        brands,
        completed,
        total,
        currentBrand,
        message: String(body.message || "").slice(0, 300) || (currentBrand ? "正在同步 " + currentBrand.name : "Airbyte 同步中"),
      });
      return json({ ok: true, ...status });
    }

    if (action === "complete") {
      const conclusion = String(body.conclusion || "failure");
      const status = await writeStatus(env, requestId, {
        status: "completed",
        conclusion,
        completedAt: new Date().toISOString(),
        htmlUrl: body.htmlUrl || null,
        message: body.message || (conclusion === "success" ? "全部品牌同步完成" : "同步失敗"),
      });
      for (const candidateMode of ["thumbnails", "full"]) {
        const key = pendingKey(candidateMode);
        const pending = await readJson(env, key);
        if (pending && pending.requestId === requestId) {
          await env.REPORT_KV.delete(key);
        }
      }
      return json({ ok: true, ...status });
    }

    return json({ ok: false, error: "unsupported_machine_action" }, 400);
  }

  const credential = browserCredential(request, env);
  if (!credential) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const requestId = normalizeRequestId(body.requestId) || ("manual-" + Date.now());
  const mode = body.mode === "thumbnails" ? "thumbnails" : "full";

  const queueKey = pendingKey(mode);
  const existingPending = await readJson(env, queueKey);
  if (existingPending && existingPending.requestId) {
    const existingStatus = await readJson(env, statusKey(existingPending.requestId));
    const stillActive = existingStatus && existingStatus.status !== "completed";
    const ageMs = Date.now() - Date.parse(existingPending.requestedAt || 0);
    if (stillActive && Number.isFinite(ageMs) && ageMs < PENDING_TTL_SECONDS * 1000) {
      return json({
        ok: true,
        status: existingStatus.status || "queued",
        requestId: existingPending.requestId,
        reused: true,
        mode: existingPending.mode || "full",
        message: existingPending.mode === "thumbnails"
          ? "已有一筆素材縮圖修復正在排隊或執行中"
          : "已有一筆全品牌同步正在排隊或執行中",
      }, 202);
    }
  }

  const requestedAt = new Date().toISOString();
  const pending = {
    requestId,
    requestedAt,
    requestedBy: credential.name || "",
    mode,
  };
  await env.REPORT_KV.put(queueKey, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
  await writeStatus(env, requestId, {
    status: "queued",
    conclusion: null,
    requestedAt,
    requestedBy: credential.name || "",
    htmlUrl: null,
    mode,
    message: mode === "thumbnails"
      ? "已送出素材縮圖修復，等待 GitHub Actions 接手"
      : "已送出，等待 GitHub Actions 接手",
  });

  return json({
    ok: true,
    status: "queued",
    requestId,
    mode,
    message: mode === "thumbnails"
      ? "素材縮圖修復已排隊"
      : "Airbyte 全品牌同步已排隊，通常會在幾分鐘內開始",
  }, 202);
}

export async function onRequestGet({ request, env }) {
  const claims = await machineClaims(request);
  const url = new URL(request.url);

  if (claims && url.searchParams.get("machine") === "pending") {
    // Thumbnail repair is intentionally checked first so it never waits behind a full
    // Airbyte sync request. The two modes have independent queue keys.
    for (const mode of ["thumbnails", "full"]) {
      const key = pendingKey(mode);
      const pending = await readJson(env, key);
      if (!pending || !pending.requestId) continue;

      const status = await readJson(env, statusKey(pending.requestId));
      if (status && status.status === "completed") {
        await env.REPORT_KV.delete(key);
        continue;
      }
      if (status && status.status === "running") {
        continue;
      }
      return json({
        ok: true,
        pending: true,
        requestId: pending.requestId,
        requestedAt: pending.requestedAt || null,
        requestedBy: pending.requestedBy || "",
        status: status && status.status || "queued",
        mode,
      });
    }
    return json({ ok: true, pending: false });
  }

  const credential = browserCredential(request, env);
  if (!credential) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const requestId = normalizeRequestId(url.searchParams.get("request_id"));
  if (!requestId) {
    return json({ ok: false, error: "missing_request_id" }, 400);
  }

  const status = await readJson(env, statusKey(requestId));
  if (!status) {
    return json({ ok: true, found: false, requestId, status: "queued" });
  }
  return json({ ok: true, found: true, ...status });
}
