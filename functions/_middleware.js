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
function isChannelCode(code) {
  return !isLegacyAdOnlyCode(code) && (isOfficialSiteCode(code) || isExternalChannelCode(code));
}

function buildLedgerProductBreakdown(ledgerAgg) {
  const allCodes = Object.keys(ledgerAgg.byCode).sort();
  const officialSiteCodes = allCodes.filter((c) => !isLegacyAdOnlyCode(c) && isOfficialSiteCode(c));
  const externalChannelCodes = allCodes.filter((c) => !isLegacyAdOnlyCode(c) && isExternalChannelCode(c) && !isOfficialSiteCode(c));
  const productCodes = allCodes.filter((c) =>
    !isLegacyAdOnlyCode(c) && !isOfficialSiteCode(c) && !isExternalChannelCode(c)
  );
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

function patchIndexHtml(html) {
  const helperStart = html.indexOf(HELPER_START);
  const helperEnd = html.indexOf(HELPER_END, helperStart);
  if (helperStart < 0 || helperEnd < 0) return { html, patched: false, reason: 'helper-markers' };
  html = html.slice(0, helperStart) + GROUPING_HELPER + html.slice(helperEnd);

  const oldDestructure = 'const { rows, channelRows } = buildLedgerProductBreakdown(ledgerAgg);';
  const newDestructure = 'const { rows, officialSiteRows, externalChannelRows } = buildLedgerProductBreakdown(ledgerAgg);';
  if (!html.includes(oldDestructure)) return { html, patched: false, reason: 'destructure' };
  html = html.replace(oldDestructure, newDestructure);

  const oldEmpty = 'if (!rows.length && !channelRows.length) {';
  const newEmpty = 'if (!rows.length && !officialSiteRows.length && !externalChannelRows.length) {';
  if (!html.includes(oldEmpty)) return { html, patched: false, reason: 'empty-check' };
  html = html.replace(oldEmpty, newEmpty);

  const tableStart = html.indexOf(CHANNEL_UI_START);
  const tableEnd = html.indexOf(CHANNEL_UI_END, tableStart);
  if (tableStart < 0 || tableEnd < 0) return { html, patched: false, reason: 'table-markers' };
  html = html.slice(0, tableStart) + BUSINESS_TABLES + html.slice(tableEnd);

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
  headers.set('x-report-model', result.patched ? 'website-groups-v2' : `patch-missed-${result.reason}`);
  return new Response(result.html, { status: response.status, statusText: response.statusText, headers });
}
