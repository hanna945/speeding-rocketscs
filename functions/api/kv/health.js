// GET /api/kv/health
// Auth-only health check. Intentionally performs zero KV operations.
export async function onRequestGet({ data }) {
  const credential = data.credential || { name: "", roster: null };
  return new Response(
    JSON.stringify({
      ok: true,
      credentialName: credential.name || "",
      credentialBrands: credential.roster || null,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}
