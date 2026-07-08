// 跟 index.html 裡「後台每日收益表(.xlsx)解析」那段邏輯完全一致(逐字同步過來),
// 只是抽成獨立檔案,讓 /api/sheets/sync.js 這支 Function 也能用同一套規則解析 Google Sheet 抓回來的資料,
// 不用另外寫一份、也不用擔心兩邊邏輯之後跑掉不一致。
// 如果之後 index.html 裡這段邏輯有調整(例如欄位寬度、起始欄變了),這裡也要跟著手動同步更新。

export const LEDGER_PRODUCT_BLOCK_START_COL = 19; // 從 T 欄(0-indexed 19)開始才是「產品代號」區塊
export const LEDGER_MONTH_SHEET_RE = /^(\d{1,2})\s*月/;

function excelDateToISO(v) {
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}
function toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : 0;
}

export function parseLedgerSheet(matrix, year) {
  if (!matrix || matrix.length < 3) return null;
  const row1 = matrix[0] || [];
  const row2 = matrix[1] || [];
  const blocks = [];
  for (let c = LEDGER_PRODUCT_BLOCK_START_COL; c < Math.max(row1.length, row2.length); c += 1) {
    if ((row2[c] || "").toString().trim() === "帳面營業額") {
      const code = (row1[c] || "").toString().trim().toUpperCase();
      if (!code) continue;
      blocks.push({
        code,
        name: (row1[c + 1] || "").toString().trim(),
        colRevenue: c, colAov: c + 1, colSpend: c + 2, colProfit: c + 4, colNetProfit: c + 5,
      });
    }
  }
  const days = [];
  let totalRow = null;
  for (let r = 2; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const dateCell = row[0];
    if (dateCell instanceof Date) {
      const iso = excelDateToISO(dateCell);
      const overall = {
        revenue: toNum(row[1]), adSpend: toNum(row[2]), profit: toNum(row[4]),
        netProfit: toNum(row[7] !== undefined && row[7] !== null && row[7] !== "" ? row[7] : row[6]),
      };
      const byCode = {};
      blocks.forEach((b) => {
        const revenue = toNum(row[b.colRevenue]);
        const spend = toNum(row[b.colSpend]);
        const aov = toNum(row[b.colAov]);
        if (revenue === 0 && spend === 0) return;
        byCode[b.code] = {
          revenue, spend, aov,
          profit: toNum(row[b.colProfit]),
          netProfit: toNum(row[b.colNetProfit]),
          orders: aov > 0 ? revenue / aov : null,
        };
      });
      days.push({ date: iso, overall, byCode });
    } else if (typeof dateCell === "string" && dateCell.trim() === "總結") {
      const overall = {
        revenue: toNum(row[1]), adSpend: toNum(row[2]), profit: toNum(row[4]),
        netProfit: toNum(row[7] !== undefined && row[7] !== null && row[7] !== "" ? row[7] : row[6]),
      };
      const byCode = {};
      blocks.forEach((b) => {
        byCode[b.code] = {
          revenue: toNum(row[b.colRevenue]), spend: toNum(row[b.colSpend]),
          profit: toNum(row[b.colProfit]), netProfit: toNum(row[b.colNetProfit]),
        };
      });
      totalRow = { overall, byCode };
      break;
    }
  }
  if (!days.length) return null;
  return { days, monthTotal: totalRow, productCodes: blocks.map((b) => b.code) };
}
