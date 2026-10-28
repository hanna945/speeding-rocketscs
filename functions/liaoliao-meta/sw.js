const SCRIPT = "const CACHE = \"report-pwa-shell-v1\";\nconst START_URL = self.registration.scope;\n\nself.addEventListener(\"install\", (event) => {\n  event.waitUntil(\n    caches.open(CACHE).then((cache) => cache.add(START_URL)).catch(() => null)\n  );\n  self.skipWaiting();\n});\n\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(self.clients.claim());\n});\n\nself.addEventListener(\"fetch\", (event) => {\n  if (event.request.method !== \"GET\") return;\n  if (event.request.mode === \"navigate\") {\n    event.respondWith(\n      fetch(event.request).catch(() => caches.match(START_URL))\n    );\n    return;\n  }\n  event.respondWith(fetch(event.request));\n});\n";
export async function onRequestGet() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}