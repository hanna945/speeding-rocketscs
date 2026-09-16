// Cloudflare Pages middleware: keep the large legacy index.html untouched while applying
// the reporting-source grouping patch at response time. Only the HTML shell is transformed;
// /api routes and all non-HTML assets pass through unchanged.

const HELPER_START = '// 已知的「通路」名稱';
const HELPER_END = 'function buildProductBreakdown(ads, minSpend) {';
const CHANNEL_UI_START = '      {channelRows.length > 0 && (';
const CHANNEL_UI_END = '      <div className="mal-roas-legend">';

const GROUPING_HELPER = `// 業績來源分三層：商品代號=一頁式網站、SHOPIFY/SHOPLINE=官網、其餘平台=外部通路。
// 花費不靠平台名稱猜歸屬；後端 parser 已依「欄位所在區塊」歸入各自網站/通路。
const OFFICIAL_SITE_NAMES = ["SHOPIFY", "SHOPLINE"];
const EXTERNAL_CHANNEL_NAMES = ["蝦皮", "MOMO", "門市", "經銷", "LINE 禮物", "LINE禮物"];
function isOfficialSiteCode(code) {
  const s = (code || "").toString().toUpperCase();
  return OFFICIAL_SITE_NAMES.some((name) => s.includes(name));
}
function isExternalChannelCode(code) {
  const s = (code || "").toString();
  return EXTERNAL_CHANNEL_NAMES.some((name) => s.includes(name));
}
function isLegacyAdOnlyCode(code) {
  const s = (code || "").toString().toUpperCase().replace(/\\s+/g, "");
  return s === "GOOGLE" || s === "門市GOOGLE";
}
function isOnePageCode(code) {
  return !isLegacyAdOnlyCode(code) && !isOfficialSiteCode(code) && !isExternalChannelCode(code);
}
function isChannelCode(code) {
  return !isLegacyAdOnlyCode(code) && (isOfficialSiteCode(code) || isExternalChannelCode(code));
}
function splitBusinessCodes(codes) {
  const unique = [...new Set((codes || []).filter((code) => !isLegacyAdOnlyCode(code)))];
  const products = unique.filter(isOnePageCode);
  const officialSites = unique.filter(isOfficialSiteCode);
  const externalChannels = unique.filter((code) => isExternalChannelCode(code) && !isOfficialSiteCode(code));
  return {
    products,
    officialSites,
    externalChannels,
    channels: [...officialSites, ...externalChannels],
    sorted: [...products, ...officialSites, ...externalChannels],
  };
}
function isBusinessGroupBoundary(index, split) {
  if (!split) return false;
  const officialStart = split.products.length;
  const externalStart = split.products.length + split.officialSites.length;
  return (index === officialStart && officialStart > 0 && split.officialSites.length > 0) ||
    (index === externalStart && externalStart > 0 && split.externalChannels.length > 0);
}
function businessCodeLabel(code) {
  if (isOfficialSiteCode(code)) return `🌐 ${code}`;
  if (isExternalChannelCode(code)) return `🔗 ${code}`;
  return code;
}
function rowsForSurface(record, surface) {
  return Object.entries((record && record.byCode) || {})
    .filter(([code]) => {
      if (surface === "official") return isOfficialSiteCode(code);
      if (surface === "external") return isExternalChannelCode(code) && !isOfficialSiteCode(code);
      return isOnePageCode(code);
    })
    .sort((a, b) => (b[1].revenue || 0) - (a[1].revenue || 0));
}
function sumSurface(record, surface) {
  return rowsForSurface(record, surface).reduce((sum, [, v]) => ({
    revenue: sum.revenue + (v.revenue || 0),
    spend: sum.spend + (v.spend || 0),
    profit: sum.profit + (v.profit || 0),
    netProfit: sum.netProfit + (v.netProfit || 0),
  }), { revenue: 0, spend: 0, profit: 0, netProfit: 0 });
}
function sumCodeAcrossDays(days, code) {
  return (days || []).reduce((sum, d) => {
    const v = d.byCode && d.byCode[code];
    if (!v) return sum;
    sum.revenue += v.revenue || 0;
    sum.spend += v.spend || 0;
    sum.profit += v.profit || 0;
    sum.netProfit += v.netProfit || 0;
    return sum;
  }, { revenue: 0, spend: 0, profit: 0, netProfit: 0 });
}
function sumOverallAcrossDays(days) {
  return (days || []).reduce((sum, d) => {
    const v = d.overall || {};
    sum.revenue += v.revenue || 0;
    sum.adSpend += v.adSpend || 0;
    sum.profit += v.profit || 0;
    sum.netProfit += v.netProfit || 0;
    return sum;
  }, { revenue: 0, adSpend: 0, profit: 0, netProfit: 0 });
}
function DailyBusinessSurfaceTable({ title, surface, record, prevRecord, threshold }) {
  const rows = rowsForSurface(record, surface);
  if (!rows.length) return null;
  const firstLabel = surface === "official" ? "網站" : "通路";
  return (
    <>
      <h3 style={{ fontFamily: "'Noto Serif TC', serif", fontWeight: 700, fontSize: 14.5, margin: "24px 0 12px" }}>{title}</h3>
      <div className="mal-scroll-wrap" style={{ overflowX: "auto" }}>
        <table className="mal-table">
          <thead><tr><th>{firstLabel}</th><th>營收</th><th>與前一天比</th><th>花費</th><th>花費佔比</th><th>淨利潤</th></tr></thead>
          <tbody>
            {rows.map(([code, v]) => {
              const prev = prevRecord && prevRecord.byCode ? prevRecord.byCode[code] : undefined;
              return (
                <tr key={code}>
                  <td>{code}</td>
                  <td>{fmtMoney(v.revenue)}</td>
                  <td>{!prevRecord ? "—" : prev === undefined ? <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>新來源</span> : <DeltaBadge value={pctChange(v.revenue, prev.revenue)} />}</td>
                  <td>{fmtMoney(v.spend)}</td>
                  <td>{adPct(v.spend, v.revenue, threshold)}</td>
                  <td>{netProfitCell(v.netProfit)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function buildLedgerProductBreakdown(ledgerAgg) {
  const allCodes = Object.keys(ledgerAgg.byCode).sort();
  const officialSiteCodes = allCodes.filter((c) => !isLegacyAdOnlyCode(c) && isOfficialSiteCode(c));
  const externalChannelCodes = allCodes.filter((c) => !isLegacyAdOnlyCode(c) && isExternalChannelCode(c) && !isOfficialSiteCode(c));
  const productCodes = allCodes.filter(isOnePageCode);
  function toRow(code) {
    const v = ledgerAgg.byCode[code];
    return { code, spend: v.spend, revenue: v.revenue, conversions: v.hasOrderEst ? v.orderEst : 0, profit: v.profit, netProfit: v.netProfit, aov: v.aov };
  }
  const rows = productCodes.map(toRow);
  const officialSiteRows = officialSiteCodes.map(toRow);
  const externalChannelRows = externalChannelCodes.map(toRow);
  const totalProductSpend = rows.reduce((s, r) => s + r.spend, 0);
  rows.forEach((r) => { r.spendShare = totalProductSpend > 0 ? (r.spend / totalProductSpend) * 100 : 0; });
  const totalOfficialSpend = officialSiteRows.reduce((s, r) => s + r.spend, 0);
  officialSiteRows.forEach((r) => { r.spendShare = totalOfficialSpend > 0 ? (r.spend / totalOfficialSpend) * 100 : 0; });
  const totalExternalSpend = externalChannelRows.reduce((s, r) => s + r.spend, 0);
  externalChannelRows.forEach((r) => { r.spendShare = totalExternalSpend > 0 ? (r.spend / totalExternalSpend) * 100 : 0; });
  return { rows, officialSiteRows, externalChannelRows };
}

`;

const BUSINESS_TABLES = `      {officialSiteRows.length > 0 && (
        <>
          <h3 style={{ fontFamily: "'Noto Serif TC', serif", fontWeight: 700, fontSize: 14.5, margin: "24px 0 12px" }}>官網業績</h3>
          <div className="mal-scroll-wrap" style={{ overflowX: "auto" }}>
            <table className="mal-table">
              <thead>
                <tr>
                  <th>網站</th><th>業績</th><th>花費</th><th>帳面利潤</th><th>客單價</th>
                </tr>
              </thead>
              <tbody>
                {officialSiteRows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code}</td>
                    <td>{fmtMoney(r.revenue, currencyCode)}</td>
                    <td>{fmtMoney(r.spend, currencyCode)}</td>
                    <td>{fmtMoney(r.profit, currencyCode)}</td>
                    <td>{r.aov !== null ? fmtMoney(r.aov, currencyCode) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {externalChannelRows.length > 0 && (
        <>
          <h3 style={{ fontFamily: "'Noto Serif TC', serif", fontWeight: 700, fontSize: 14.5, margin: "24px 0 12px" }}>其他通路業績</h3>
          <div className="mal-scroll-wrap" style={{ overflowX: "auto" }}>
            <table className="mal-table">
              <thead>
                <tr>
                  <th>通路</th><th>業績</th><th>花費</th><th>帳面利潤</th><th>客單價</th>
                </tr>
              </thead>
              <tbody>
                {externalChannelRows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code}</td>
                    <td>{fmtMoney(r.revenue, currencyCode)}</td>
                    <td>{fmtMoney(r.spend, currencyCode)}</td>
                    <td>{fmtMoney(r.profit, currencyCode)}</td>
                    <td>{r.aov !== null ? fmtMoney(r.aov, currencyCode) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

`;

function replaceRequired(html, from, to, reason) {
  if (!html.includes(from)) return { html, ok: false, reason };
  return { html: html.replace(from, to), ok: true };
}

function patchIndexHtml(html) {
  const helperStart = html.indexOf(HELPER_START);
  const helperEnd = html.indexOf(HELPER_END, helperStart);
  if (helperStart < 0 || helperEnd < 0) return { html, patched: false, reason: 'helper-markers' };
  html = html.slice(0, helperStart) + GROUPING_HELPER + html.slice(helperEnd);

  let r = replaceRequired(
    html,
    'const { rows, channelRows } = buildLedgerProductBreakdown(ledgerAgg);',
    'const { rows, officialSiteRows, externalChannelRows } = buildLedgerProductBreakdown(ledgerAgg);',
    'destructure'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  r = replaceRequired(
    html,
    'if (!rows.length && !channelRows.length) {',
    'if (!rows.length && !officialSiteRows.length && !externalChannelRows.length) {',
    'empty-check'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  // Weekly/monthly performance totals now match the one-page rows shown in the chart/table.
  r = replaceRequired(
    html,
    `  const totalRevenue = ledgerAgg.overall.revenue;
  const totalSpend = ledgerAgg.overall.adSpend;
  const totalProfit = ledgerAgg.overall.profit;
  const totalConversions = rows.reduce((s, r) => s + r.conversions, 0);
  const overallRoas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const chartRows = [...rows].sort((a, b) => (b.spend > 0 ? b.revenue / b.spend : 0) - (a.spend > 0 ? a.revenue / a.spend : 0));
  const chartData = chartRows.map((r) => {
    const roas = r.spend > 0 ? r.revenue / r.spend : 0;
    const tier = roasTier(roas);
    return { label: r.code, value: roas, color: tier ? tier.color : "var(--ink-soft)" };
  });`,
    `  const totalRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (r.profit || 0), 0);
  const totalConversions = rows.reduce((s, r) => s + r.conversions, 0);
  const overallRoas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const chartRows = [...rows].sort((a, b) => {
    if (a.spend <= 0 && b.spend > 0) return 1;
    if (b.spend <= 0 && a.spend > 0) return -1;
    return (b.spend > 0 ? b.revenue / b.spend : 0) - (a.spend > 0 ? a.revenue / a.spend : 0);
  });
  // ROAS without spend is undefined, not 0x. Keep those rows in the table as "—",
  // but do not draw fake 0x bars in the chart.
  const chartData = chartRows.filter((r) => r.spend > 0).map((r) => {
    const roas = r.revenue / r.spend;
    const tier = roasTier(roas);
    return { label: r.code, value: roas, color: tier ? tier.color : "var(--ink-soft)" };
  });`,
    'performance-totals-chart'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  r = replaceRequired(
    html,
    `      <div style={{ marginBottom: 22 }}>
        <HorizontalBarChart data={chartData} formatValue={(v) => `${v.toFixed(1)}x`} />
      </div>`,
    `      <div style={{ marginBottom: 22 }}>
        {chartData.length > 0 ? (
          <HorizontalBarChart data={chartData} formatValue={(v) => `${v.toFixed(1)}x`} />
        ) : (
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>這個期間的一頁式代號沒有可計算 ROAS 的花費資料。</p>
        )}
      </div>`,
    'performance-chart-ui'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  const tableStart = html.indexOf(CHANNEL_UI_START);
  const tableEnd = html.indexOf(CHANNEL_UI_END, tableStart);
  if (tableStart < 0 || tableEnd < 0) return { html, patched: false, reason: 'table-markers' };
  html = html.slice(0, tableStart) + BUSINESS_TABLES + html.slice(tableEnd);

  // Daily matrix ordering: one-page -> official site -> external channel.
  r = replaceRequired(
    html,
    `function sortCodesChannelFirst(codes) {
  const channels = codes.filter(isChannelCode);
  const products = codes.filter((c) => !isChannelCode(c));
  return { channels, products, sorted: [...channels, ...products] };
}`,
    `function sortCodesChannelFirst(codes) {
  return splitBusinessCodes(codes);
}`,
    'daily-sort-helper'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  // Daily selected-day chart must show one-page revenue only.
  r = replaceRequired(
    html,
    'const dayCodes = Object.entries(focusDayRecord.byCode).sort((a, b) => b[1].revenue - a[1].revenue);',
    'const dayCodes = rowsForSurface(focusDayRecord, "one_page");',
    'daily-chart-codes'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;
  html = html.replace('{activeFocusDay} 業績比例分析', '{activeFocusDay} 一頁式業績比例分析');

  r = replaceRequired(
    html,
    `                          {Object.entries(focusDayRecord.byCode)
                            .sort((a, b) => b[1].revenue - a[1].revenue)
                            .map(([code, v]) => {`,
    `                          {rowsForSurface(focusDayRecord, "one_page")
                            .map(([code, v]) => {`,
    'daily-onepage-table'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;
  html = html.replace('<th>代號</th><th>營收(後台)</th>', '<th>一頁式代號</th><th>營收(後台)</th>');

  // Replace the misleading whole-store total under a one-page-only table with one-page subtotal.
  r = replaceRequired(
    html,
    `                          <tr>
                            <td className="mal-row-month">🏬 全店合計</td>
                            <td className="mal-row-month">{fmtMoney(focusDayRecord.overall.revenue)}</td>
                            <td className="mal-row-month">
                              {prevDayRecord ? <DeltaBadge value={pctChange(focusDayRecord.overall.revenue, prevDayRecord.overall.revenue)} /> : "—"}
                            </td>
                            <td className="mal-row-month">{fmtMoney(focusDayRecord.overall.adSpend)}</td>
                            <td className="mal-row-month">{adPct(focusDayRecord.overall.adSpend, focusDayRecord.overall.revenue, adRatioThresholds[activeBrandId])}</td>
                            <td className="mal-row-month">{netProfitCell(focusDayRecord.overall.netProfit)}</td>
                          </tr>`,
    `                          {(() => {
                            const t = sumSurface(focusDayRecord, "one_page");
                            const p = prevDayRecord ? sumSurface(prevDayRecord, "one_page") : null;
                            return (
                              <tr>
                                <td className="mal-row-month">一頁式小計</td>
                                <td className="mal-row-month">{fmtMoney(t.revenue)}</td>
                                <td className="mal-row-month">{p ? <DeltaBadge value={pctChange(t.revenue, p.revenue)} /> : "—"}</td>
                                <td className="mal-row-month">{fmtMoney(t.spend)}</td>
                                <td className="mal-row-month">{adPct(t.spend, t.revenue, adRatioThresholds[activeBrandId])}</td>
                                <td className="mal-row-month">{netProfitCell(t.netProfit)}</td>
                              </tr>
                            );
                          })()}`,
    'daily-onepage-subtotal'
  );
  if (!r.ok) return { html: r.html, patched: false, reason: r.reason };
  html = r.html;

  // Insert official-site and external-channel tables before the existing daily explanatory note.
  const dailyNoteText = '🏬 全店合計取自後台每日收益表本身的總表欄位';
  const noteTextIndex = html.indexOf(dailyNoteText);
  if (noteTextIndex < 0) return { html, patched: false, reason: 'daily-note' };
  const noteStart = html.lastIndexOf('                    <p style={{ fontSize: 11', noteTextIndex);
  if (noteStart < 0) return { html, patched: false, reason: 'daily-note-start' };
  const dailySurfaceTables = `                    <DailyBusinessSurfaceTable
                      title="官網業績"
                      surface="official"
                      record={focusDayRecord}
                      prevRecord={prevDayRecord}
                      threshold={adRatioThresholds[activeBrandId]}
                    />
                    <DailyBusinessSurfaceTable
                      title="其他通路業績"
                      surface="external"
                      record={focusDayRecord}
                      prevRecord={prevDayRecord}
                      threshold={adRatioThresholds[activeBrandId]}
                    />
`;
  html = html.slice(0, noteStart) + dailySurfaceTables + html.slice(noteStart);

  // Daily matrix labels and visual boundaries follow the same three groups.
  html = html.replaceAll('i === dailyMatrixSplit.channels.length && dailyMatrixSplit.products.length > 0', 'isBusinessGroupBoundary(i, dailyMatrixSplit)');
  html = html.replace('{isChannelCode(code) ? `🔗 ${code}` : code}', '{businessCodeLabel(code)}');
  html = html.replace('每日 x 產品代號矩陣', '每日 × 業績來源矩陣');

  // Matrix totals must use canonical daily rows, not product summary formulas that may be shifted/broken.
  html = html.replace('{dailyMonthRecord && dailyMonthRecord.monthTotal && (', '{dailyMonthRecord && sortedDailyDays.length > 0 && (');
  html = html.replace('{fmtMoney(dailyMonthRecord.monthTotal.overall.revenue)}', '{fmtMoney(sumOverallAcrossDays(sortedDailyDays).revenue)}');
  html = html.replace('{fmtMoney(dailyMonthRecord.monthTotal.overall.adSpend)}', '{fmtMoney(sumOverallAcrossDays(sortedDailyDays).adSpend)}');
  html = html.replace('{adPct(dailyMonthRecord.monthTotal.overall.adSpend, dailyMonthRecord.monthTotal.overall.revenue, adRatioThresholds[activeBrandId])}', '{adPct(sumOverallAcrossDays(sortedDailyDays).adSpend, sumOverallAcrossDays(sortedDailyDays).revenue, adRatioThresholds[activeBrandId])}');
  html = html.replace('{netProfitCell(dailyMonthRecord.monthTotal.overall.netProfit)}', '{netProfitCell(sumOverallAcrossDays(sortedDailyDays).netProfit)}');
  html = html.replace('const v = dailyMonthRecord.monthTotal.byCode[code];', 'const v = sumCodeAcrossDays(sortedDailyDays, code);');

  html = html.replace('投放成效(含通路業績)', '投放成效(含官網/通路業績)');
  return { html, patched: true, reason: 'ok' };
}

export async function onRequest(context) {
  const response = await context.next();
  const url = new URL(context.request.url);
  if (url.pathname !== '/' && url.pathname !== '/index.html') return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const source = await response.text();
  const result = patchIndexHtml(source);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('x-report-model', result.patched ? 'website-groups-v3' : `patch-missed-${result.reason}`);
  return new Response(result.html, { status: response.status, statusText: response.statusText, headers });
}
