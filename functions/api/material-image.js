function bad(status, message) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "shopline-proxy.hanna-104.workers.dev" ||
    host === "huggingface.co" ||
    host.endsWith(".fbcdn.net") ||
    host === "facebook.com" ||
    host.endsWith(".facebook.com");
  return allowed ? url : null;
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const upstream = allowedUrl(url.searchParams.get("u") || "");
  if (!upstream) return bad(400, "invalid image url");

  let res;
  try {
    res = await fetch(upstream.toString(), {
      headers: {
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "speedingscs-material-image/1.0",
      },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch (e) {
    return bad(502, "image fetch failed: " + (e && e.message ? e.message : String(e)));
  }

  if (!res.ok) return bad(502, "upstream image HTTP " + res.status);
  const type = String(res.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("image/")) return bad(415, "upstream is not an image");

  const headers = new Headers();
  headers.set("Content-Type", type);
  headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: 200, headers });
}
