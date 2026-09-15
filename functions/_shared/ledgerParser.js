// Google Sheets daily ledger parser.
// Goal: parse by semantic labels and brand/profile markers, never by fragile fixed offsets.
// Critical overall fields fail closed through diagnostics.errors so syncAccountLedger can avoid overwriting good KV data.
// Revenue blocks are classified by business surface: one-page site, official site, or external channel.
// Spend ownership follows the physical block where the spend column lives.

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
    startsWithAny("廣告費", "廣告費用", "抽成費用"),
  ],
  genericNetProfit: [
    includesAny("稅後淨利"),
    startsWithAny("真實利潤"),
    startsWithAny("實際利潤"),
  ],
};

const OFFICIAL_SITE_CODES = new Set(["SHOPLINE", "SHOPIFY"]);
const EXTERNAL_CHANNEL_CODES = new Set(["蝦皮", "MOMO", "LINE 禮物", "門市", "經銷"]);

function normalizeBlockCode(raw) {
  const text = cleanText(raw);
  const upper = text.toUpperCase();
  if (upper.includes("SHOPLINE")) return "SHOPLINE";
  if (upper.includes("SHOPIFY")) return "SHOPIFY";
  if (text.includes("蝦皮")) return "蝦皮";
  if (upper.includes("MOMO")) return "MOMO";
  if (text.replace(/\s+/g, "").includes("LINE禮物")) return "LINE 禮物";
  if (text.startsWith("門市")) return "門市";
  if (text.startsWith("經銷")) return "經銷";
  return upper;
}

function classifyBlock(code) {
  if (OFFICIAL_SITE_CODES.has(code)) return "official_site";
  if (EXTERNAL_CHANNEL_CODES.has(code)) return "external_channel";
  return "one_page";
}

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
      row2.some((v) => cleanText(v).replace(/\s+/g, "") === "FB(ASC)廣告費") ||
      row1.some((v) => cleanText(v).toUpperCase() === "GOOGLE ADS"),
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
  return { col, header1: cleanText(row1[col]), header2: cleanText(row2[col]) };
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
    errors: [], warnings: [], columns: {}, blocks: [],
  };

  const revenueStarts = findAllRevenueStarts(row1, row2);
  if (!revenueStarts.length) {
    diagnostics.errors.push("找不到任何「帳面營業額」欄位");
    return { days: [], monthTotal: null, productCodes: [], diagnostics };
  }

  const overallStart = revenueStarts[0];
  const blockStarts = revenueStarts.slice(1).filter((c) => cleanText(row1[c]));
  const overallEnd = blockStarts.length ? blockStarts[0] : width;

  const overallRevenueCol = overallStart;
  const overallAdSpendCol = findColumn(row2, overallStart, overallEnd, FIELD_MATCHERS.adSpend);
  const overallProfitCol = findColumn(row2, overallStart, overallEnd, FIELD_MATCHERS.profit);
  const overallNetProfitCol = findColumn(
    row2, overallStart, overallEnd,
    profile.overallNetProfit?.length ? profile.overallNetProfit : FIELD_MATCHERS.genericNetProfit
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
  for (let i = 0; i < blockStarts.length; i += 1) {
    const start = blockStarts[i];
    const end = i + 1 < blockStarts.length ? blockStarts[i + 1] : width;
    const rawCode = cleanText(row1[start]);
    const code = normalizeBlockCode(rawCode);
    if (!code) continue;

    const kind = classifyBlock(code);
    const colSpend = findColumn(row2, start + 1, end, FIELD_MATCHERS.blockSpend);
    const colGoogleSpend = findGoogleSpendInsideBlock(row1, row2, start, end);
    const spendCols = [colSpend];
    // Only an official-site block may absorb a Google spend column, and only when
    // that Google column is physically inside the same official-site block.
    if (kind === "official_site" && colGoogleSpend != null) spendCols.push(colGoogleSpend);

    const block = {
      code, rawCode, kind,
      name: cleanText(row1[start + 1]),
      colRevenue: start,
      colAov: findColumn(row2, start + 1, end, FIELD_MATCHERS.aov),
      colSpend,
      spendCols: [...new Set(spendCols.filter((c) => c != null))],
      colProfit: findColumn(row2, start + 1, end, FIELD_MATCHERS.profit),
      colNetProfit: findColumn(row2, start + 1, end, FIELD_MATCHERS.genericNetProfit),
      colGoogleSpend,
    };

    diagnostics.blocks.push({
      code, rawCode, kind, start, end,
      revenue: columnMeta(row1, row2, block.colRevenue),
      aov: columnMeta(row1, row2, block.colAov),
      spend: columnMeta(row1, row2, block.colSpend),
      spendColumns: block.spendCols.map((col) => columnMeta(row1, row2, col)),
      profit: columnMeta(row1, row2, block.colProfit),
      netProfit: columnMeta(row1, row2, block.colNetProfit),
      googleSpend: columnMeta(row1, row2, block.colGoogleSpend),
    });

    if (block.colSpend == null && block.colProfit == null && block.colNetProfit == null) {
      diagnostics.warnings.push(`${code}: 只辨識到營收，沒有找到廣告費/利潤欄位`);
    }
    blocks.push(block);
  }

  // Keep standalone Google-like columns only as summary diagnostics. They are NOT
  // business rows and are never assigned to a one-page site / official site / channel.
  const claimedBlockSpendCols = new Set(blocks.flatMap((b) => b.spendCols || []));
  const standaloneSpendSummaries = [];
  for (let c = 0; c < width; c += 1) {
    if (claimedBlockSpendCols.has(c)) continue;
    const h1 = upperText(row1[c]);
    const h2 = upperText(row2[c]);
    const isGoogle = h1.includes("GOOGLE") || h2.includes("GOOGLE");
    const isSpend = h2.includes("廣告費") || h2 === "GOOGLE";
    if (isGoogle && isSpend) {
      standaloneSpendSummaries.push({ code: "GOOGLE", label: cleanText(row1[c]) || "Google Ads", colSpend: c });
    }
  }
  diagnostics.standaloneSpendSummaries = standaloneSpendSummaries.map((s) => columnMeta(row1, row2, s.colSpend));

  if (diagnostics.errors.length) {
    return { days: [], monthTotal: null, productCodes: blocks.map((b) => b.code), diagnostics };
  }

  const days = [];
  const adjustments = [];
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
      const spend = (b.spendCols?.length ? b.spendCols : [b.colSpend])
        .reduce((sum, col) => sum + safeCellNumber(row, col), 0);
      const aov = safeCellNumber(row, b.colAov);
      const profit = safeCellNumber(row, b.colProfit);
      const netProfit = safeCellNumber(row, b.colNetProfit);
      if (revenue === 0 && spend === 0 && profit === 0 && netProfit === 0) continue;
      byCode[b.code] = {
        revenue, spend, aov, profit, netProfit,
        ...(includeOrders ? { orders: aov > 0 ? revenue / aov : null } : {}),
      };
    }
    return byCode;
  };

  const buildAdSources = (row) => {
    const adSources = {};
    for (const source of standaloneSpendSummaries) {
      const spend = safeCellNumber(row, source.colSpend);
      if (!spend) continue;
      if (!adSources[source.code]) adSources[source.code] = { spend: 0, label: source.label };
      adSources[source.code].spend += spend;
    }
    return adSources;
  };

  const mergeAdjustmentIntoLastDay = (row, label) => {
    if (!days.length) return false;
    const overall = buildOverall(row);
    const byCode = buildByCode(row, false);
    const adSources = buildAdSources(row);
    const hasOverall = Object.values(overall).some((v) => Number.isFinite(v) && v !== 0);
    const hasByCode = Object.values(byCode).some((v) =>
      [v.revenue, v.spend, v.profit, v.netProfit].some((n) => Number.isFinite(n) && n !== 0)
    );
    if (!hasOverall && !hasByCode) return false;

    const target = days[days.length - 1];
    target.overall.revenue += overall.revenue || 0;
    target.overall.adSpend += overall.adSpend || 0;
    target.overall.profit += overall.profit || 0;
    target.overall.netProfit += overall.netProfit || 0;

    Object.entries(byCode).forEach(([code, v]) => {
      if (!target.byCode[code]) {
        target.byCode[code] = { revenue: 0, spend: 0, aov: 0, profit: 0, netProfit: 0, orders: null };
      }
      const dest = target.byCode[code];
      dest.revenue += v.revenue || 0;
      dest.spend += v.spend || 0;
      dest.profit += v.profit || 0;
      dest.netProfit += v.netProfit || 0;
      if (dest.orders === undefined) dest.orders = null;
    });

    Object.entries(adSources).forEach(([code, v]) => {
      if (!target.adSources) target.adSources = {};
      if (!target.adSources[code]) target.adSources[code] = { spend: 0, label: v.label };
      target.adSources[code].spend += v.spend || 0;
    });

    adjustments.push({ label: cleanText(label) || "未標示調整", appliedDate: target.date, overall, byCode, adSources });
    return true;
  };

  for (let r = 2; r < matrix.length; r += 1) {
    const row = matrix[r] || [];
    const dateCell = row[0];
    if (dateCell instanceof Date) {
      const iso = excelDateToISO(dateCell);
      if (!iso) continue;
      days.push({ date: iso, overall: buildOverall(row), byCode: buildByCode(row, true), adSources: buildAdSources(row) });
      continue;
    }
    if (typeof dateCell === "string" && cleanText(dateCell) === "總結") {
      totalRow = { overall: buildOverall(row), byCode: buildByCode(row, false), adSources: buildAdSources(row) };
      break;
    }
    if (days.length) mergeAdjustmentIntoLastDay(row, dateCell);
  }

  if (!days.length) {
    diagnostics.errors.push("沒有辨識到任何日期資料列");
    return { days: [], monthTotal: totalRow, productCodes: blocks.map((b) => b.code), diagnostics };
  }

  // Reconcile only official sites and external channels to their explicit month-total rows.
  // One-page product totals are not auto-forced because several historical sheets contain
  // product-level total formulas that intentionally differ or have broken ranges.
  if (totalRow && days.length) {
    const lastDay = days[days.length - 1];
    const reconcilableCodes = [...new Set(
      blocks.filter((b) => b.kind === "official_site" || b.kind === "external_channel").map((b) => b.code)
    )];
    for (const code of reconcilableCodes) {
      const sourceTotal = totalRow.byCode?.[code];
      if (!sourceTotal) continue;
      const summed = { revenue: 0, spend: 0, profit: 0, netProfit: 0 };
      days.forEach((d) => {
        const v = d.byCode?.[code];
        if (!v) return;
        Object.keys(summed).forEach((k) => { summed[k] += v[k] || 0; });
      });
      const delta = {};
      Object.keys(summed).forEach((k) => {
        const diff = (sourceTotal[k] || 0) - summed[k];
        if (Math.abs(diff) > 1) delta[k] = diff;
      });
      if (!Object.keys(delta).length) continue;

      if (!lastDay.byCode[code]) {
        lastDay.byCode[code] = { revenue: 0, spend: 0, aov: 0, profit: 0, netProfit: 0, orders: null };
      }
      const dest = lastDay.byCode[code];
      Object.entries(delta).forEach(([k, diff]) => { dest[k] = (dest[k] || 0) + diff; });
      dest.orders = null;
      adjustments.push({
        label: `${code} 月結調整`, appliedDate: lastDay.date,
        overall: { revenue: 0, adSpend: 0, profit: 0, netProfit: 0 },
        byCode: { [code]: delta }, adSources: {},
      });
      diagnostics.warnings.push(`${code}: 已套用月結差額 ${Object.entries(delta).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${Math.round(v * 100) / 100}`).join("、")}`);
    }
  }

  const reconciliation = { overallDiff: {} };
  if (totalRow) {
    const summed = { revenue: 0, adSpend: 0, profit: 0, netProfit: 0 };
    days.forEach((d) => Object.keys(summed).forEach((k) => { summed[k] += d.overall[k] || 0; }));
    Object.keys(summed).forEach((k) => {
      const diff = summed[k] - (totalRow.overall[k] || 0);
      if (Math.abs(diff) > 1) reconciliation.overallDiff[k] = diff;
    });
    if (Object.keys(reconciliation.overallDiff).length) {
      const labels = { revenue: "營收", adSpend: "廣告費", profit: "帳面利潤", netProfit: "淨利" };
      const detail = Object.entries(reconciliation.overallDiff)
        .map(([k, v]) => `${labels[k] || k}${v > 0 ? "+" : ""}${Math.round(v * 100) / 100}`).join("、");
      diagnostics.warnings.push(`來源表「總結」與逐日加總不一致：${detail}`);
    }
  }

  const onePageProductCodes = [...new Set(blocks.filter((b) => b.kind === "one_page").map((b) => b.code))];
  const officialSiteCodes = [...new Set(blocks.filter((b) => b.kind === "official_site").map((b) => b.code))];
  const externalChannelCodes = [...new Set(blocks.filter((b) => b.kind === "external_channel").map((b) => b.code))];

  return {
    days,
    monthTotal: totalRow,
    productCodes: [...new Set(blocks.map((b) => b.code))],
    onePageProductCodes,
    officialSiteCodes,
    externalChannelCodes,
    // Backward compatibility for any older consumer that still expects one channel list.
    salesPlatformCodes: [...officialSiteCodes, ...externalChannelCodes],
    adSourceCodes: [...new Set(standaloneSpendSummaries.map((a) => a.code))],
    adjustments,
    diagnostics: {
      ...diagnostics,
      adjustments: adjustments.map((a) => ({ label: a.label, appliedDate: a.appliedDate })),
      reconciliation,
    },
  };
}
