const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../assets/autopilot.js');
const A = globalThis.HJAutopilot;
const html = fs.readFileSync(new URL('../index.html', 'file://' + __filename), 'utf8');
const purchaseCode = html.slice(html.indexOf('const PURCHASE_ACTION_PRIORITY'), html.indexOf('// 組出直接跳轉到 Meta'));
const pick = vm.runInNewContext(purchaseCode + '\npickPurchaseValue');
const target = A.targets(3, 300, 'TWD');
const active = { active:true, effectiveStatus:'ACTIVE' }, delivery = {recentDays:3};
const base = {spend:3000, conversions:12, revenue:12000, roas:4, cpa:250, impressions:20000, clicks:300, ctr:1.5, cpc:10, cpm:150, frequency:2, cvr:4};
const verdict = (r = {}, b = {}, t=target, d=delivery, s=active) => A.evaluate({...base,...r},{...base,...b},s,t,d);
test('Taipei calendar excludes today at UTC boundary, month/year/leap and DST boundaries',()=>{
 assert.deepEqual(A.ranges('2026-10-06T16:01:00Z','Asia/Taipei'),{today:'2026-10-07',recentSince:'2026-10-04',recentUntil:'2026-10-06',baseSince:'2026-09-27',baseUntil:'2026-10-03'});
 assert.equal(A.ranges('2026-01-01T00:00:00Z','Asia/Taipei').baseSince,'2025-12-22');
 assert.equal(A.ranges('2024-03-01T00:00:00Z','Asia/Taipei').recentUntil,'2024-02-29');
 assert.equal(A.ranges('2026-03-09T07:01:00Z','America/Los_Angeles').recentUntil,'2026-03-08');
});
test('purchase dedup uses existing priority; zero ROAS is valid and link clicks never fall back to all clicks',()=>{
 const actions=[{action_type:'omni_purchase',value:'2'},{action_type:'purchase',value:'2'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'2'}];
 const m=A.metrics({spend:'100',impressions:'1000',inline_link_clicks:'0',clicks:'100',ctr:'10',actions},pick);
 assert.equal(m.conversions,2);assert.equal(m.roas,0);assert.equal(m.ctr,0);assert.equal(m.cpc,null);
 assert.equal(A.metrics({spend:100,impressions:1000,clicks:100},pick).ctr,null);
 assert.equal(pick([{action_type:'omni_purchase',value:'0'},...actions.slice(1)]),0);
});
test('new ads and low spend/purchase remain LEARNING, unknown status never treated active',()=>{
 assert.equal(verdict({spend:10000,conversions:0},{},target,{recentDays:1}).decision,'LEARNING');
 assert.equal(verdict({spend:100}).decision,'LEARNING');
 assert.equal(verdict({conversions:1}).confidence,'LOW');
 assert.equal(verdict({}, {conversions:0}).decision,'LEARNING');
 assert.equal(verdict({}, {},target,delivery,{effectiveStatus:'UNKNOWN'}).decision,'LEARNING');
});
test('zero purchases uses brand target stop; no CPA target cannot recommend PAUSE',()=>{
 assert.equal(verdict({spend:600,conversions:0,roas:0,cpa:null}).decision,'PAUSE');
 assert.equal(verdict({spend:599,conversions:0,roas:0,cpa:null}).decision,'LEARNING');
 assert.equal(verdict({spend:5000,conversions:0},{},A.targets(3,null,'TWD')).decision,'LEARNING');
 assert.equal(A.targets(3,800,'TWD').stopSpend,1600);
 assert.equal(A.targets(3,30,'USD').stopSpend,60);
});
test('SCALE requires target CPA and baseline support',()=>{
 assert.equal(verdict({roas:4.8,cpa:220}).decision,'SCALE');
 assert.notEqual(verdict({roas:4.8,cpa:220},{roas:5}).decision,'SCALE');
 assert.notEqual(verdict({roas:4.8,cpa:220},{},A.targets(3,null,'TWD')).decision,'SCALE');
});
test('DOWN requires target miss AND comparative deterioration',()=>{
 assert.equal(verdict({roas:2,cpa:450}).decision,'DOWN');
 assert.equal(verdict({roas:2,cpa:450},{roas:2,cpa:450}).decision,'HOLD');
});
test('high frequency alone is not fatigue; rising frequency + CTR fall + efficiency loss is fatigue',()=>{
 assert.notEqual(verdict({frequency:6}).diagnosis,'CREATIVE_FATIGUE');
 const v=verdict({frequency:3.2,ctr:.7,cpa:320,roas:3.1});
 assert.equal(v.decision,'FATIGUE');assert.equal(v.diagnosis,'CREATIVE_FATIGUE');
 assert.notEqual(verdict({frequency:3.2,ctr:.7,cpa:320,roas:3.1},{frequency:4}).decision,'FATIGUE');
});
test('diagnoses distinguish auction, traffic, conversion; sparse signals never high',()=>{
 assert.equal(verdict({cpm:200}).diagnosis,'AUCTION_COST');
 assert.equal(verdict({ctr:.8}).diagnosis,'TRAFFIC_PROBLEM');
 assert.equal(verdict({ctr:.8}).confidence,'LOW');
 assert.equal(verdict({cvr:2,cpa:380,roas:2.8}).diagnosis,'CONVERSION_PROBLEM');
 assert.equal(verdict({roas:5,cpa:200}).confidence,'HIGH');
 assert.notEqual(verdict({roas:5,cpa:200,conversions:5}).confidence,'HIGH');
 assert.equal(verdict().diagnosis,'HEALTHY');
});
test('sorting respects risk then material spend; unknown/null values sort last',()=>{
 const row=(id,d,spend,roas=1)=>({adId:id,decision:d,status:active,recent:{spend,roas}});
 const rows=[row('learn','LEARNING',5),row('small','PAUSE',600),row('large','PAUSE',2000),row('down','DOWN',1000)];
 assert.deepEqual(A.sortRows(rows).map(r=>r.adId),['large','small','down','learn']);
 assert.deepEqual(A.sortRows([row('null','HOLD',2,null),row('zero','HOLD',1,0)],'roas').map(r=>r.adId),['zero','null']);
 assert.equal(A.change(0,4),-100);assert.equal(A.change(4,0),null);
});
test('KV history namespace is brand scoped',async()=>{
 const {extractBrandFromKey,canAccessBrand}=await import('../functions/_shared/auth.js');
 assert.equal(extractBrandFromKey('autopilot-history:123::run'),'123');
 assert.equal(canAccessBrand({brands:['456']},extractBrandFromKey('autopilot-history:123::run')),false);
});
