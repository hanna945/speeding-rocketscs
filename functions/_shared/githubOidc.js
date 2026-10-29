const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = ISSUER + "/.well-known/jwks";
const EXPECTED_AUDIENCE = "speedingscs-airbyte";
const EXPECTED_REPOSITORY = "hanna945/speeding-rocketscs";
const EXPECTED_REF = "refs/heads/main";

function decodeBase64Url(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJsonPart(input) {
  const bytes = decodeBase64Url(input);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function verifySignature(token, header, signingInput, signature) {
  const response = await fetch(JWKS_URL, {
    headers: { "User-Agent": "speedingscs-airbyte-oidc/1.0" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!response.ok) throw new Error("oidc_jwks_unavailable");
  const jwks = await response.json();
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("oidc_signing_key_not_found");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    new TextEncoder().encode(signingInput)
  );
}

export async function verifyGitHubActionsOidc(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    if (header.alg !== "RS256") return null;

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== ISSUER) return null;
    if (claims.aud !== EXPECTED_AUDIENCE) return null;
    if (claims.repository !== EXPECTED_REPOSITORY) return null;
    if (claims.ref !== EXPECTED_REF) return null;
    if (!claims.exp || claims.exp <= now) return null;
    if (claims.nbf && claims.nbf > now + 30) return null;

    const workflowRef = String(claims.workflow_ref || "");
    if (!workflowRef.startsWith(EXPECTED_REPOSITORY + "/.github/workflows/airbyte-meta-sync.yml@")) return null;

    const ok = await verifySignature(
      token,
      header,
      parts[0] + "." + parts[1],
      decodeBase64Url(parts[2])
    );
    if (!ok) return null;
    return claims;
  } catch {
    return null;
  }
}
