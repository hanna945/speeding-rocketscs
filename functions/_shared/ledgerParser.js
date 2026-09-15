// Google Sheets daily ledger parser.
// Goal: parse by semantic labels and brand/profile markers, never by fragile fixed offsets.
// Critical overall fields fail closed through diagnostics.errors so syncAccountLedger can avoid overwriting good KV data.

export const LEDGER_MONTH_SHEET_RE = /^(\d{1,2})\s*月/;

function cleanText(v) {
  return (v == null ? "" : String(v))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function upperText(v) {
  return cleanText(v).toUpperCase();
}

function excelDateToISO(v) {
  if (!(v instanceof Date)) return null;
  return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
}

function toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function isExact(...labels) {
  const wanted = new Set(labels.map(cleanText));
  return (label) => wanted.has(cleanText(label));
}

function startsWithAny(...prefixes) {
  const wanted = prefixes.map(cleanText);
  return (label) => {
    const s = cleanText(label);
    return wanted.some((p) => s.startsWith(p));
  };
}

function includesAny(...parts) {
  const wanted = parts.map(cleanText);
  return (label) => {
    const s = cleanText(label);
    return wanted.some((p) => s.includes(p));
  };
}

const FIELD_MATCHERS = {
  revenue: [isExact("帳面營業額")],
  adSpend: [isExact("廣告費"), isExact("廣告費用")],
  profit: [startsWithAny("帳面利潤")],
  aov: [isExact("平均客單價")],
  blockSpend: [
    isExact("FB廣告費"),
    startsWithAny("廣告費", "廣告費用"),
  ],
  genericNetProfit: [
    includesAny("稅後淨利"),
    startsWithAny("真實利潤"),
    startsWithAny("實際利潤"),
  ],
};

// Profiles only decide semantic priority and detection. They do not hard-code column numbers.
export const LEDGER_PROFILES = [
  {
    id: "hj",
    label: "H&J",
    detect: ({ row1, row2 }) =>
      row2.some((v) => cleanText(v).includes("(改)稅後淨利")) ||
      row2.some((v) => cleanText(v) === "全品FB廣告費") ||
      row1.some((v) => cleanText(v).includes("H&J官網")),
    overallNetProfit: [
      (label) => cleanText(label).includes("(改)稅後淨利"),
      isExact("稅後淨利"),
      includesAny("稅後淨利"),
    ],
  },
  {
    id: "kp",
    label: "KP",
    detect: ({ row1, row2 }) =>
      row2.some((v) => cleanText(v) === "(全品項)廣告費用") ||
      row2.some((v) => cleanText(v) === "(活動用)廣告費用") ||
      row1.some((v) => cleanText(v) === "門市Google"),
    overallNetProfit: [startsWithAny("真實利潤")],
  },
  {
    id: "jgao",
    label: "J.GAO",
    detect: ({ row1, row2 }) =>
      row2.some((v) => cleanText(v).includes("行銷分析用")) ||
      row2.some((v) => cleanText(v).includes("綜合品項行銷活動 FB廣告費")) ||
      row1.some((v) => cleanText(v) === "J.GAO"),
    overallNetProfit: [startsWithAny("實際利潤")],
  },
  {
    id: "mavis",
    label: "Mavis",
    detect: ({ row1, row2 }) =>
      row2.some((v) => cleanText(v) === "FB (ASC) 廣告費") ||
      row1.some((v) => cleanText(v) === "Google ads"),
    overallNetProfit: [startsWithAny("實際利潤"), startsWithAny("真實利潤")],
  },
  {
    id: "yk",
    label: "YK",
    detect: ({ row1 }) => {
      const labels = row1.map(cleanText);
      return labels.includes("蝦皮") && labels.some((v) => v.startsWith("門市(")) && labels.includes("經銷");
    },
    overallNetProfit: [startsWithAny("真實利潤"), startsWithAny("實際利潤")],
  },
  {
    id: "generic",
    label: "Generic",
    detect: () => true,
    overallNetProfit: FIELD_MATCHERS.genericNetProfit,
  },
];

function detectProfile(row1, row2) {
  const ctx = { row1, row2 };
  return LEDGER_PROFILES.find((profile) => profile.detect(ctx)) || LEDGER_PROFILES[LEDGER_PROFILES.length - 1];
}

function findColumn(row2, start, end, matchers) {
  for (const matcher of matchers) {
    for (let c = start; c < end; c += 1) {
      if (matcher(row2[c])) return c;
    }
  }
  return null;
}

function findAllRevenueStarts(row1, row2) {
  const out = [];
  const width = Math.max(row1.length, row2.length);
  for (let c = 0; c < width; c += 1) {
    if (cleanText(row2[c]) === "帳面營業額") out.push(c);
  }
  return out;
}

function columnMeta(row1, row2, col) {
  if (col == null) return null;
  return {
    col,
    header1: cleanText(row1[col]),
    header2: cleanText(row2[col]),
  };
}

function safeCellNumber(row, col) {
  return col == null ? 0 : toNum(row[col]);
}

function findGoogleSpendInsideBlock(row1, row2, start, end) {
  for (let c = start + 1; c < end; c += 1) {
    const h1 = upperText(row1[c]);
    const h2 = upperText(row2[c]);
    if (h2 === "GOOGLE" || h1 === "GOOGLE" || h1 === "GOOGLE ADS") return c;
  }
  return null;
}

export function parseLedgerSheet(matrix, year, context = {}) {
  if (!matrix || matrix.length < 3) return null;

  const row1 = matrix[0] || [];
  const row2 = matrix[1] || [];
  const width = Math.max(row1.length, row2.length);
  const profile = detectProfile(row1, row2);
  const diagnostics = {
    accountId: context.accountId || null,
    sheetId: context.sheetId || null,
    tab: context.tab || null,
    profile: profile.id,
    errors: [],
    warnings: [],
    columns: {},
    blocks: [],
  };

  const revenueStarts = findAllRevenueStarts(row1, row2);
  if (!revenueStarts.length) {
    diagnostics.errors.push("找不到任何「帳面營業額」欄位");
    return { days: [], monthTotal: null, productCodes: [], diagnostics };
  }

  const overallStart = revenueStarts[0];
  const productStarts = revenueStarts.slice(1).filter((c) => cleanText(row1[c]));
  const overallEnd = productStarts.length ? productStarts[0] : width;

  const overallRevenueCol = overallStart;
  const overallAdSpendCol = findColumn(row2, overallStart, overallEnd, FIELD_MATCHERS.adSpend);
  const overallProfitCol = findColumn(row2, overallStart, overallEnd, FIELD_MATCHERS.profit);
  const overallNetProfitCol = findColumn(
    row2,
    overallStart,
    overallEnd,
    profile.overallNetProfit && profile.overallNetProfit.length ? profile.overallNetProfit : FIELD_MATCHERS.genericNetProfit
  );

  diagnostics.columns.overallRevenue = columnMeta(row1, row2, overallRevenueCol);
  diagnostics.columns.overallAdSpend = columnMeta(row1, row2, overallAdSpendCol);
  diagnostics.columns.overallProfit = columnMeta(row1, row2, overallProfitCol);
  diagnostics.columns.overallNetProfit = columnMeta(row1, row2, overallNetProfitCol);

  if (overallRevenueCol == null) diagnostics.errors.push("找不到全店營收欄位「帳面營業額」");
  if (overallAdSpendCol == null) diagnostics.errors.push("找不到全店廣告費欄位「廣告費」");
  if (overallNetProfitCol == null) diagnostics.errors.push(`找不到 ${profile.label} 的全店淨利欄位`);
  if (overallProfitCol == null) diagnostics.warnings.push("找不到全店「帳面利潤」欄位，帳面利潤將以 0 顯示");

  const blocks = [];
  for (let i = 0; i < productStarts.length; i += 1) {
    const start = productStarts[i];
    const end = i + 1 < productStarts.length ? productStarts[i + 1] : width;
    const code = upperText(row1[start]);
    if (!code) continue;

    const block = {
      code,
      name: cleanText(row1[start + 1]),
      colRevenue: start,
      colAov: findColumn(row2, start + 1, end, FIELD_MATCHERS.aov),
      colSpend: findColumn(row2, start + 1, end, FIELD_MATCHERS.blockSpend),
      colProfit: findColumn(row2, start + 1, end, FIELD_MATCHERS.profit),
      colNetProfit: findColumn(row2, start + 1, end, FIELD_MATCHERS.genericNetProfit),
      colGoogleSpend: findGoogleSpendInsideBlock(row1, row2, start, end),
    };

    diagnostics.blocks.push({
      code,
      start,
      end,
      revenue: columnMeta(row1, row2, block.colRevenue),
      aov: columnMeta(row1, row2, block.colAov),
      spend: columnMeta(row1, row2, block.colSpend),
      profit: columnMeta(row1, row2, block.colProfit),
      netProfit: columnMeta(row1, row2, block.colNetProfit),
      googleSpend: columnMeta(row1, row2, block.colGoogleSpend),
    });

    // Not every channel has AOV/ad spend/profit/net profit, so these are warnings rather than hard errors.
    if (block.colSpend == null && block.colProfit == null && block.colNetProfit == null) {
      diagnostics.warnings.push(`${code}: 只辨識到營收，沒有找到廣告費/利潤欄位`);
    }

    blocks.push(block);

    // Preserve the existing H&J behavior: if a block itself contains a GOOGLE spend column,
    // expose it as a separate spend-only code in the daily matrix.
    if (block.colGoogleSpend != null) {
      blocks.push({
        code: "GOOGLE",
        name: "Google廣告",
        colRevenue: null,
        colAov: null,
        colSpend: block.colGoogleSpend,
        colProfit: null,
        colNetProfit: null,
        isSpendOnly: true,
      });
    }
  }

  // Fail closed for core overall fields. Caller should not overwrite previously-good KV data.
  if (diagnostics.errors.length) {
    return { days: [], monthTotal: null, productCodes: blocks.map((b) => b.code), diagnostics };
  }

  const days = [];
  let totalRow = null;

  const buildOverall = (row) => ({
    revenue: safeCellNumber(row, overallRevenueCol),
    adSpend: safeCellNumber(row, overallAdSpendCol),
    profit: safeCellNumber(row, overallProfitCol),
    netProfit: safeCellNumber(row, overallNetProfitCol),
  });

  const buildByCode = (row, includeOrders) => {
    const byCode = {};
    for (const b of blocks) {
      const revenue = safeCellNumber(row, b.colRevenue);
      const spend = safeCellNumber(row, b.colSpend);
      const aov = safeCellNumber(row, b.colAov);
      const profit = safeCellNumber(row, b.colProfit);
      const netProfit = safeCellNumber(row, b.colNetProfit);
      if (revenue === 0 && spend === 0 && profit === 0 && netProfit === 0) continue;
      byCode[b.code] = {
        revenue,
        spend,
        aov,
        profit,
        netProfit,
        ...(includeOrders ? { orders: aov > 0 ? revenue / aov : null } : {}),
      };
    }
    return byCode;
  };

  for (let r = 2; r < matrix.length; r += 1) {
    const row = matrix[r] || [];
    const dateCell = row[0];

    if (dateCell instanceof Date) {
      const iso = excelDateToISO(dateCell);
      if (!iso) continue;
      days.push({ date: iso, overall: buildOverall(row), byCode: buildByCode(row, true) });
      continue;
    }

    if (typeof dateCell === "string" && cleanText(dateCell) === "總結") {
      totalRow = { overall: buildOverall(row), byCode: buildByCode(row, false) };
      break;
    }
  }

  if (!days.length) {
    diagnostics.errors.push("沒有辨識到任何日期資料列");
    return { days: [], monthTotal: totalRow, productCodes: blocks.map((b) => b.code), diagnostics };
  }

  return {
    days,
    monthTotal: totalRow,
    productCodes: [...new Set(blocks.map((b) => b.code))],
    diagnostics,
  };
}
