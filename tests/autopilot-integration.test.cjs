const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
require('../assets/autopilot.js');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const code=html.slice(html.indexOf('  // ---------- Ads radar:'),html.indexOf('  function apiErrorHint'));
const purchase=html.slice(html.indexOf('const PURCHASE_ACTION_PRIORITY'),html.indexOf('// 組出直接跳轉到 Meta'));
function harness({failHistory=false, delay=null, duplicate=false, budgetDenied=false}={}) {
 const outputs={}, writes=[], calls=[];
 const ctx={HJAutopilot,URL,URLSearchParams,Date,crypto:require('node:crypto').webcrypto, apiToken:'fixture-token-not-real',activeBrandId:'123',apiAccountId:'123',autopilotRequestRef:{current:0},autopilotContextRef:{current:'brand123'},roasTargets:{123:3},cpaThresholds:{123:300},apiErrorHint:()=>'',
  storageSetStrict:async(k,v)=>{if(failHistory)throw new Error('fixture storage offline');writes.push([k,JSON.parse(v)]);},
  fetchGraphApi:async(url)=>{
   const u=new URL(url);calls.push(u);
   if(delay)await delay(u);
   if(!u.pathname.endsWith('/insights')&&!u.pathname.endsWith('/ads'))return {currency:'TWD',timezone_name:'Asia/Taipei'};
   if(u.pathname.endsWith('/ads')){
    if(budgetDenied&&u.searchParams.get('fields').includes('daily_budget'))throw Object.assign(new Error('optional fields denied'),{code:100});
    return {data:[{id:'1',name:'Fixture Ad',effective_status:'ACTIVE'},{id:'2',name:'No delivery',effective_status:'ACTIVE'}]};
   }
   const r=JSON.parse(u.searchParams.get('time_range'));
   if(u.searchParams.has('time_increment')){
    const t=HJAutopilot.ranges(Date.now(),'Asia/Taipei');
    return {data:[0,1,2].map(i=>({ad_id:'1',impressions:'2000',date_start:new Date(Date.parse(t.recentSince)+i*86400000).toISOString().slice(0,10)}))};
   }
   const row={ad_id:'1',spend:'3000',impressions:'20000',reach:'10000',inline_link_clicks:'300',frequency:'2',actions:[{action_type:'omni_purchase',value:'12'},{action_type:'purchase',value:'12'}],action_values:[{action_type:'omni_purchase',value:'12000'},{action_type:'purchase',value:'12000'}]};
   return {data:duplicate?[row,row]:[row]};
  }
 };
 for(const key of ['Loading','Error','Data','HistoryStatus'])ctx['setAutopilot'+key]=v=>outputs[key]=v;
 vm.createContext(ctx);vm.runInContext(purchase+'\n'+code,ctx);
 return {ctx,outputs,writes,calls};
}
test('manual run reads full windows, includes zero-delivery active ads, writes a deduplicated complete shadow snapshot',async()=>{
 const h=harness();await h.ctx.runAutopilotAnalysis();
 assert.equal(h.outputs.Error,'');assert.equal(h.outputs.Loading,false);
 const s=h.outputs.Data;assert.equal(s.totals.conversions,12);assert.equal(s.rows.length,2);assert.equal(s.rows.find(r=>r.adId==='2').decision,'LEARNING');
 assert.equal(h.writes.length,1);assert.equal(h.writes[0][1].mode,'SHADOW_ONLY');assert.match(h.writes[0][0],/^autopilot-history:123::/);
 assert.ok(!JSON.stringify(h.writes).includes('fixture-token-not-real'));
 assert.ok(h.calls.every(u=>u.origin==='https://graph.facebook.com'&&!u.searchParams.has('method')));
});
test('brand switch while Meta request is pending cannot publish data or save history for the new brand',async()=>{
 let release,called;const entered=new Promise(r=>called=r);const gate=new Promise(r=>release=r);
 const h=harness({delay:async()=>{called();await gate;}});
 const run=h.ctx.runAutopilotAnalysis();await entered;
 h.ctx.autopilotContextRef.current='brand456';h.ctx.autopilotRequestRef.current++;release();await run;
 assert.equal(h.outputs.Data,null);assert.equal(h.writes.length,0);
});
test('history failure is visible and does not discard successful analysis',async()=>{
 const h=harness({failHistory:true});await h.ctx.runAutopilotAnalysis();assert.ok(h.outputs.Data);assert.match(h.outputs.HistoryStatus,/儲存失敗/);
});
test('duplicate ad rows fail closed rather than overwrite or inflate totals',async()=>{
 const h=harness({duplicate:true});await h.ctx.runAutopilotAnalysis();assert.match(h.outputs.Error,/重複 Ad ID/);assert.equal(h.writes.length,0);
});
test('optional budget permission failure falls back to readable status with visible warning',async()=>{
 const h=harness({budgetDenied:true});await h.ctx.runAutopilotAnalysis();assert.equal(h.outputs.Data.warnings.length,1);assert.equal(h.outputs.Data.rows[0].status.dailyBudgetRaw,null);
});
test('wrong origin, override method and repeated pagination are rejected',async()=>{
 const h=harness();await assert.rejects(h.ctx.autopilotGet('https://example.com/', '',()=>true),/不允許/);
 await assert.rejects(h.ctx.autopilotGet('https://graph.facebook.com/?method=post','',()=>true),/不允許/);
 h.ctx.fetchGraphApi=async()=>({data:[],paging:{next:'https://graph.facebook.com/same'}});
 await assert.rejects(h.ctx.autopilotPages('https://graph.facebook.com/same','fixture',()=>true),/分頁不完整/);
});
test('history read/write is denied across brand scopes and ROAS writes preserve other brands',async()=>{
 const middleware=await import('../functions/api/kv/_middleware.js');
 const {onRequestPut}=await import('../functions/api/kv/item/[key].js');
 const env={TEAM_CREDENTIALS:JSON.stringify({'test-key':{name:'fixture',brands:['456']}})};
 for(const method of ['GET','PUT']) {
  const request=new Request('https://preview.example/api/kv/item/autopilot-history%3A123%3A%3Arun',{method,headers:{'X-Team-Key':'test-key'}});
  const response=await middleware.onRequest({request,env,data:{},next:()=>{throw Error('must not reach storage');}});assert.equal(response.status,403);
 }
 let saved;
 await onRequestPut({params:{key:'meta-api-roas-targets'},env:{REPORT_KV:{get:async()=>JSON.stringify({123:3,456:4}),put:async(k,v)=>saved=JSON.parse(v)}},request:new Request('https://preview.example',{method:'PUT',body:JSON.stringify({123:999,456:5})}),data:{credential:{brands:['456']}}});
 assert.deepEqual(saved,{123:3,456:5});
});
