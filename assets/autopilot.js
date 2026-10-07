/* Shadow-only pure diagnostics. No network, timers or Meta mutation operations. */
(function (root) {
  const VERSION = 'shadow-diagnostics-2';
  const API_VERSION = 'v26.0';
  const ORDER = { PAUSE: 0, DOWN: 1, FATIGUE: 2, SCALE: 3, HOLD: 4, LEARNING: 5 };
  const DIAGNOSES = { CREATIVE_FATIGUE: '素材疲乏', AUCTION_COST: '競價成本上升', CONVERSION_PROBLEM: '轉換環節待查', TRAFFIC_PROBLEM: '流量吸引力下降', LOW_DATA: '資料不足', HEALTHY: '目前正常' };
  const RULES = Object.freeze({ minPurchases: 3, scalePurchases: 5, highPurchases: 10, minImpressions: 1000, minClicks: 30, ctrRatio: .75, frequencyRatio: 1.15, cpaRatio: 1.2, roasRatio: .8, cpmRatio: 1.2, cvrRatio: .75, scaleRoasRatio: 1.15 });
  const number = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const positive = v => number(v) > 0 ? Number(v) : null;
  function ranges(now, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const today = `${p.year}-${p.month}-${p.day}`;
    const ago = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
    return { today, recentSince: ago(3), recentUntil: ago(1), baseSince: ago(10), baseUntil: ago(4) };
  }
  function metrics(row, pickPurchaseValue) {
    const r = row || {};
    const spend = number(r.spend) || 0, impressions = number(r.impressions) || 0;
    const conversions = pickPurchaseValue(r.actions), revenue = pickPurchaseValue(r.action_values);
    // Never substitute all clicks for inline link clicks. Zero and unavailable differ.
    const clicks = number(r.inline_link_clicks), reach = number(r.reach);
    return { spend, conversions, revenue, impressions, reach, clicks,
      roas: spend > 0 ? revenue / spend : null,
      cpa: conversions > 0 ? spend / conversions : null,
      ctr: impressions > 0 && clicks != null ? clicks / impressions * 100 : null,
      cpc: clicks > 0 ? spend / clicks : null,
      cpm: impressions > 0 ? spend / impressions * 1000 : null,
      frequency: number(r.frequency) ?? (reach > 0 ? impressions / reach : null),
      cvr: clicks > 0 ? conversions / clicks * 100 : null,
    };
  }
  // A product context is reserved for future target resolution; v2 uses brand settings only.
  function targets(roas, cpa, currency, productContext = null) {
    const targetRoas = positive(roas), targetCpa = positive(cpa);
    const floors = { TWD: 500, USD: 15, EUR: 15, GBP: 12, HKD: 120, JPY: 2000 };
    const floor = floors[currency] ?? (targetCpa ? targetCpa * .5 : null);
    return { targetRoas, targetCpa, currency, source: 'brand', productContext,
      minimumSpend: targetCpa ? Math.max(floor, targetCpa) : floor,
      stopSpend: targetCpa ? Math.max(floor, targetCpa * 2) : null };
  }
  function change(current, baseline) {
    return current != null && baseline > 0 ? (current / baseline - 1) * 100 : null;
  }
  function evaluate(r, b, status, target, delivery) {
    const R = RULES;
    const result = (decision, diagnosis, reason, signals = 0) => {
      const high = decision !== 'LEARNING' && decision !== 'PAUSE' && r.conversions >= R.highPurchases && b.conversions >= R.highPurchases && r.impressions >= 3000 && b.impressions >= 3000 && target.minimumSpend != null && r.spend >= target.minimumSpend * 2 && signals >= 3 && delivery.recentDays >= 3;
      const medium = decision !== 'LEARNING' && r.conversions >= 3 && b.conversions >= 3 && signals >= 2;
      return { decision, diagnosis, confidence: high ? 'HIGH' : medium ? 'MEDIUM' : 'LOW', reason, signals };
    };
    if (!status || status.effectiveStatus === 'UNKNOWN') return result('LEARNING', 'LOW_DATA', '廣告狀態讀取不完整，無法確認是否投放中。');
    if (!delivery || delivery.recentDays < 3) return result('LEARNING', 'LOW_DATA', '最近 3 個完整日尚未累積 3 日曝光；新廣告或重新投放先觀察。');
    if (target.minimumSpend == null || r.spend < target.minimumSpend || r.impressions < R.minImpressions) return result('LEARNING', 'LOW_DATA', '花費或曝光樣本不足；尚未達到品牌觀察門檻。');
    if (r.conversions === 0 && target.stopSpend != null && r.spend >= target.stopSpend) return result('PAUSE', 'CONVERSION_PROBLEM', `3 個完整日都有曝光，花費 ${r.spend.toFixed(2)} ≥ 停損觀察值 ${target.stopSpend.toFixed(2)}，仍為 0 購買；請先查回傳延遲、追蹤與網站。僅 PAUSE Candidate。`, 2);
    if (r.conversions < R.minPurchases || b.conversions < R.minPurchases || b.impressions < R.minImpressions || b.spend < target.minimumSpend) return result('LEARNING', 'LOW_DATA', '3D 或 7D 的購買／花費／曝光樣本不足，暫不評判好壞。');
    const down = (x, y, ratio) => x != null && y > 0 && x < y * ratio;
    const up = (x, y, ratio) => x != null && y > 0 && x > y * ratio;
    const stable = (x, y) => x != null && y > 0 && x >= y * .9 && x <= y * 1.1;
    const clicksEnough = r.clicks >= R.minClicks && b.clicks >= R.minClicks;
    const ctrDown = clicksEnough && down(r.ctr, b.ctr, R.ctrRatio);
    const cpaUp = up(r.cpa, b.cpa, R.cpaRatio), roasDown = down(r.roas, b.roas, R.roasRatio);
    const worse = cpaUp || roasDown;
    const freqUp = up(r.frequency, b.frequency, R.frequencyRatio);
    let diagnosis = 'HEALTHY', cause = '未見明確異常訊號。', signals = 0;
    if (ctrDown && freqUp && worse) {
      diagnosis = 'CREATIVE_FATIGUE'; signals = 3;
      cause = '連結 CTR 下降超過 25%，Frequency 上升超過 15%，且 CPA 上升或 ROAS 下滑，較像素材疲乏；需人工確認。';
    } else if (clicksEnough && up(r.cpm, b.cpm, R.cpmRatio) && stable(r.ctr, b.ctr) && stable(r.cvr, b.cvr)) {
      diagnosis = 'AUCTION_COST'; signals = 3;
      cause = 'CPM 上升超過 20%，連結 CTR 與購買／連結點擊比率維持 ±10%，可能與競價成本有關。';
    } else if (clicksEnough && r.ctr >= b.ctr * .9 && down(r.cvr, b.cvr, R.cvrRatio) && worse) {
      diagnosis = 'CONVERSION_PROBLEM'; signals = 3;
      cause = '連結 CTR 未明顯下降，但購買／連結點擊比率下降超過 25%，效率同步惡化，請查網站、優惠及追蹤。';
    } else if (ctrDown) {
      diagnosis = 'TRAFFIC_PROBLEM'; signals = 1;
      cause = '連結 CTR 下降超過 25%，但尚無足夠訊號確認素材疲乏。';
    }
    if (diagnosis === 'HEALTHY' && worse) {
      diagnosis = 'CONVERSION_PROBLEM'; cause = 'CPA 或 ROAS 惡化，但無法從現有點擊訊號分離原因，請查轉換與歸因。'; signals = 1;
    }
    const belowTarget = (target.targetCpa && r.cpa > target.targetCpa * 1.25) || (target.targetRoas && r.roas < target.targetRoas * .8);
    if (belowTarget && worse) return result('DOWN', diagnosis, '目前效率差於品牌目標，且較 7D 基準明顯惡化。' + cause + ' 僅建議減量觀察。', Math.max(signals, 2));
    if (diagnosis === 'CREATIVE_FATIGUE') return result('FATIGUE', diagnosis, cause, signals);
    if (diagnosis === 'HEALTHY' && target.targetRoas && target.targetCpa && r.conversions >= R.scalePurchases && r.roas >= target.targetRoas * R.scaleRoasRatio && r.cpa <= target.targetCpa && r.roas >= b.roas && r.cpa <= b.cpa) return result('SCALE', diagnosis, '購買 ≥5、ROAS 超過品牌目標 15%、CPA 達標，ROAS 與 CPA 均未差於 7D 基準。僅建議 SCALE +10%。' + cause, 3);
    const missingTarget = !target.targetCpa || !target.targetRoas ? ' 品牌目標未完整設定，不提供 SCALE；未設 CPA 時不提供 PAUSE。' : '';
    return result('HOLD', diagnosis, cause + ' 尚未達到其他建議條件。' + missingTarget, signals);
  }
  function sortRows(rows, key = 'risk', activeOnly = true) {
    return rows.filter(r => !activeOnly || r.status.active).slice().sort((a, b) => {
      if (key === 'risk') return ORDER[a.decision] - ORDER[b.decision] || b.recent.spend - a.recent.spend || a.adId.localeCompare(b.adId);
      const x = a.recent[key], y = b.recent[key];
      return (x == null) - (y == null) || (y ?? 0) - (x ?? 0) || b.recent.spend - a.recent.spend;
    });
  }
  root.HJAutopilot = Object.freeze({ VERSION, API_VERSION, ORDER, DIAGNOSES, RULES, ranges, metrics, targets, change, evaluate, sortRows });
})(typeof window === 'undefined' ? globalThis : window);
