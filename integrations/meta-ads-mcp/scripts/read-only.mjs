import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";

const mode = process.env.MODE || "accounts";
const accountIds = (process.env.ACCOUNT_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => x.replace(/^act_/, ""));
const datePreset = process.env.DATE_PRESET || "last_30d";

if (!process.env.META_ACCESS_TOKEN) {
  throw new Error("META_ACCESS_TOKEN is required.");
}

const upstreamEntry = path.resolve(
  "integrations/meta-ads-mcp/upstream/dist/index.js"
);

const allowedTools = new Set([
  "ads_get_ad_accounts",
  "ads_portfolio_summary"
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [upstreamEntry, "--transport", "stdio"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn"
  },
  stderr: "inherit"
});

const client = new Client(
  { name: "hj-meta-ads-readonly-bridge", version: "0.1.0" },
  { capabilities: {} }
);

await client.connect(transport);

try {
  const listed = await client.listTools();
  const readOnly = new Map(
    listed.tools.map((tool) => [
      tool.name,
      tool.annotations?.readOnlyHint === true
    ])
  );

  for (const name of allowedTools) {
    if (!readOnly.get(name)) {
      throw new Error(
        `Safety guard failed: upstream tool ${name} is not marked read-only.`
      );
    }
  }

  let request;

  if (mode === "accounts") {
    request = {
      name: "ads_get_ad_accounts",
      arguments: {}
    };
  } else if (mode === "portfolio") {
    if (accountIds.length === 0) {
      throw new Error("portfolio mode requires ACCOUNT_IDS.");
    }
    if (accountIds.length > 20) {
      throw new Error("portfolio mode supports at most 20 account IDs.");
    }
    request = {
      name: "ads_portfolio_summary",
      arguments: {
        account_ids: accountIds,
        date_preset: datePreset
      }
    };
  } else {
    throw new Error(`Unsupported MODE: ${mode}`);
  }

  if (!allowedTools.has(request.name)) {
    throw new Error(`Blocked tool: ${request.name}`);
  }

  const result = await client.callTool(request);

  const output = {
    generated_at: new Date().toISOString(),
    mode,
    date_preset: mode === "portfolio" ? datePreset : null,
    account_ids: mode === "portfolio" ? accountIds : null,
    result
  };

  await fs.writeFile(
    "meta-ads-output.json",
    JSON.stringify(output, null, 2),
    "utf8"
  );

  for (const item of result.content ?? []) {
    if (item.type === "text") {
      console.log(item.text);
    }
  }

  console.log("Saved meta-ads-output.json");
} finally {
  await client.close();
}
