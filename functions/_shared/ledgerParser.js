// 跟 index.html 裡「後台每日收益表(.xlsx)解析」那段邏輯完全一致(逐字同步過來),
// 只是抽成獨立檔案,讓 /api/sheets/sync.js 這支 Function 也能用同一套規則解析 Google Sheet 抓回來的資料,
// 不用另外寫一份、也不用擔心兩邊邏輯之後跑掉不一致。
// 如果之後 index.html 裡這段邏輯有調整(例如欄位寬度、起始欄變了),這裡跟 H-J/functions/_shared/ledgerParser.js、brand-report-cron-sync/src/ledgerParser.js
// 也要跟著手動同步更新——三份是否一致,可以用 tools/check-ledger-parser-sync.js 檢查。

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
  // 不再寫死從T欄(index19)開始掃描——這個假設對某些品牌是錯的(例如宥凱的整體總表只到第8欄,
  // 產品代號第9欄就開始了,寫死19會把前面的代號整批跳過)。改成從第1欄開始逐欄掃描,
  // 但「帳面營業額」第一次出現一定是整體/全店總表本身(不是產品代號),要跳過不當成代號,
  // 從第二次出現開始才是真正的產品代號區塊——不管整體總表實際多寬,都能正確定位。
  let skippedOverall = false;
  for (let c = 1; c < Math.max(row1.length, row2.length); c += 1) {
    if ((row2[c] || "").toString().trim() === "帳面營業額") {
      if (!skippedOverall) { skippedOverall = true; continue; }
      const code = (row1[c] || "").toString().trim().toUpperCase();
      if (!code) continue;
      // 蝦皮、MOMO 這兩個代號沒有「平均客單價」這一欄,導致後面欄位整批往左遞補一格,
      // 固定位移量在這兩個代號上會直接抓錯欄——平均客單價/廣告費/帳面利潤/稅後淨利全部改用文字比對定位。
      const SEARCH_LIMIT = 12;
      let colAov = null;
      let colSpend = null;
      let colProfit = null;
      let colNetProfit = null;
      let colGoogleSpend = null; // 只有少數代號(目前已知:H&J一頁業績的SHOPLINE區塊)會有這欄,大部分代號沒有
      for (let k = c + 1; k < c + SEARCH_LIMIT; k++) {
        const label = (row2[k] || "").toString().trim();
        if (colAov === null && label === "平均客單價") colAov = k;
        // 廣告費/帳面利潤,原本用精確比對,MOMO、LINE禮物的欄名其實是「廣告費(平台抽成)」,
        // 門市、經銷的利潤欄名是「帳面利潤:扣貨物成本」「帳面利潤:貨物成本」這種帶冒號後綴的寫法,
        // 精確比對全部對不上、會落到後面的固定位移量保底(而保底位移量對這幾個代號來說是錯的,
        // 通常會抓到旁邊的百分比顯示欄,數字很小但不是0,不會被『沒資料』的判斷擋下來)。
        // 改成 startsWith,只要開頭是這幾個字就算數,涵蓋全部後綴變體。
        // 2026-07-30新增:「FB廣告費」也算數(H&J一頁業績SHOPLINE區塊的實際欄名不是「廣告費」,是
        // 「FB廣告費」,原本比對不到、導致搜尋一路延伸到緊接著的下一個代號區塊,誤抓別人的廣告費欄位當
        // 成自己的,兩個代號因此顯示出一模一樣的數字。加上這個比對後,能在自己的欄位範圍內就找到符合的
        // 標籤,不會再往下一個區塊搜尋——SEARCH_LIMIT刻意維持12不變,這是所有品牌共用的搜尋範圍,
        // 縮小範圍風險較高(可能連累其他品牌原本就需要搜尋較遠欄位的情況),只用更精確的標籤比對來解決。
        if (colSpend === null && (label.startsWith("廣告費") || label === "FB廣告費")) colSpend = k;
        if (colGoogleSpend === null && label === "GOOGLE") colGoogleSpend = k;
        if (colProfit === null && label.startsWith("帳面利潤")) colProfit = k;
        if (colNetProfit === null && (label === "稅後淨利" || label.startsWith("實際利潤") || label.startsWith("真實利潤"))) colNetProfit = k;
      }
      blocks.push({
        code,
        name: (row1[c + 1] || "").toString().trim(),
        colRevenue: c,
        colAov: colAov,
        colSpend: colSpend !== null ? colSpend : c + 2,
        colProfit: colProfit !== null ? colProfit : c + 4,
        colNetProfit: colNetProfit !== null ? colNetProfit : c + 6,
        colGoogleSpend,
      });
      // Google廣告費比照其他通路(蝦皮、MOMO等)的做法,獨立列成自己的一個代號區塊,不是塞在SHOPLINE
      // 裡面的附屬欄位——這樣矩陣總覽/選一天/每週/每月才能跟其他代號一樣,自動出現在同樣的地方。
      // 這是純廣告費支出(不是產品線),沒有自己的營收/利潤,固定填0,不是沒抓到資料。
      if (colGoogleSpend !== null) {
        blocks.push({
          code: "GOOGLE",
          name: "Google廣告",
          colRevenue: null,
          colAov: null,
          colSpend: colGoogleSpend,
          colProfit: null,
          colNetProfit: null,
          isSpendOnly: true,
        });
      }
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
