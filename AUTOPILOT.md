# Ads radar — Shadow diagnostics v2

All changes belong to `feature/hj-ads-autopilot-v1`, Draft PR #1. No Meta writes, execution adapter, background analysis, or Cron. `PAUSE` means **PAUSE Candidate**; `SCALE` means **SCALE +10% suggestion**. There is no execute button.

## Audit of v1

Existing 3D/7D fetch, brand targets, styling, purchase deduplication and dashboard were retained. Fixed zero-revenue ROAS being null; all-click CTR vs link-click denominator mismatch; unknown statuses defaulting active; silent pagination truncation; missing baseline/new-ad safeguards; in-flight results returning after brand changes; missing reach/CPC; missing revenue card, confidence, diagnosis, filters and history. Existing shared ROAS settings were not brand-filtered server-side; they now use the existing scoped merge policy.

## Data

Autopilot alone uses Marketing API v26.0 (Meta official Python Business SDK `apiconfig.py` and `adobjects/{adaccount,ad,adset,adsinsights}.py` checked on 2026-10-07). Existing report API routes are unchanged. This is field/schema verification, not proof that the user's token has access.

- Account: `currency,timezone_name`. Missing/invalid timezone fails closed. Calendar date arithmetic uses the account IANA timezone, captures today once and excludes today.
- Insights: `ad_id,ad_name,campaign_name,adset_name,spend,actions,action_values,impressions,reach,inline_link_clicks,frequency`, `level=ad`, `use_account_attribution_setting=true`. Three complete days versus the preceding seven, with no overlap. A separate daily impressions read establishes observed delivery days. No summing daily reach/frequency.
- Ads: `id,name,effective_status,created_time,campaign{name},adset{id,name,start_time,daily_budget,lifetime_budget}`. Also retrieves active ads without delivery. Both period ID sets are included. Optional detail permission/field errors retry basic status and display a warning; authorization/token errors fail.
- Derive ROAS, CPA, link CTR/CPC, CPM, and attributed purchases/link-click ratio. The latter is a diagnostic proxy, not website session CVR, and includes account attribution effects. Missing link clicks never fall back to all clicks.
- Purchase and value use the **unchanged existing `pickPurchaseValue`** priority: omni_purchase, purchase, pixel purchase, then existing fallbacks. Never add overlapping action types.
- Ad creation and ad-set scheduled start are labeled accurately; neither is represented as actual ad first delivery. Earliest exposure is only “first observed within 10 days.”
- Budget retains exact Meta API raw units, labeled in UI, without assuming all currencies use a /100 divisor. Campaign budget or field permissions may leave it unavailable.

Example at account-local 2026-10-07: recent 2026-10-04–06; baseline 2026-09-27–10-03.

## Provisional rules (not statistically calibrated probabilities)

Brand ROAS defaults to the app's existing 3; CPA has no invented default. Resolver reserves product context but uses brand targets only.

- Minimum currency observation floors: TWD 500, USD/EUR 15, GBP 12, HKD 120, JPY 2000. Other currencies require a target CPA and use 0.5× CPA as the floor. Minimum sample spend = max(floor, target CPA) when set.
- LEARNING: unknown status; fewer than 3 recent complete calendar days with impressions; spend below sample threshold; fewer than 1,000 impressions; fewer than 3 purchases in either comparison period, or inadequate baseline spend/impressions.
- PAUSE exception to purchase count: all 3 days delivered, recent spend ≥ max(currency floor, 2× target CPA), 1,000+ impressions, zero purchases. No target CPA → no PAUSE. Confidence LOW because no purchases; verify tracking and delayed attribution manually.
- DOWN: CPA > target ×1.25 or ROAS < target ×0.8, plus CPA > baseline ×1.2 or ROAS < baseline ×0.8, after sample gates.
- FATIGUE: link CTR < baseline ×0.75, frequency > baseline ×1.15, efficiency deterioration; each period needs 30+ link clicks. DOWN has decision precedence if its conditions also hold, but CREATIVE_FATIGUE diagnosis remains visible.
- SCALE: ≥5 recent purchases, ROAS ≥ target ×1.15, CPA ≤ target, ROAS ≥ baseline and CPA ≤ baseline, complete targets, no conflicting diagnostic signal.
- HOLD: no other decision gate reached. Non-active ads show retrospective diagnostics only and are excluded by default.
- Diagnosis: fatigue (3 signals), auction CPM +20% with CTR and purchase/click ratio within ±10%, conversion ratio −25% with CTR stable and efficiency worse, traffic CTR −25%, LOW_DATA, or HEALTHY. Ambiguous efficiency deterioration is explicitly labeled for manual investigation, not a confirmed cause.
- HIGH requires 10+ purchases and 3,000+ impressions in both periods, recent spend ≥2× sample floor, 3 recent delivery days and ≥3 supporting signals. MEDIUM requires 3+ purchases in both periods and ≥2 signals; otherwise LOW. Confidence is heuristic evidence strength, not a probability.

3D and 7D frequency have unequal time horizons; raw period values are displayed, never normalized by dividing by days. Rising 3D over 7D is a conservative auxiliary signal, not proof of fatigue. Attribution lag and promotion changes still require human judgment.

## Shadow history and isolation

Each successful **manual** run saves one unique account-scoped KV snapshot:
`autopilot-history:<accountId>::<timestamp>:<uuid>`.

Envelope: timestamp (`syncedAt`), brand/account, timezone, currency, period boundaries, rule version + parameters, target snapshot and attribution setting. Each row contains ad ID, decision, diagnosis, confidence, both metric sets, changes, explanation and delivery/status metadata. No token is persisted. Existing strict cloud save is used; failures are shown explicitly, not silently reported as saved locally. No retention deletion or outcome validation job is introduced. KV listing may be eventually consistent; a history browser and 24/48/72-hour validation are future work.

History namespace participates in existing brand-scoped middleware and list filtering. New history access fails closed unless TEAM_SECRET or TEAM_CREDENTIALS is configured; unauthenticated legacy list requests do not expose history keys. The first branch preview was observed with no team challenge, so real history requires configuring Preview authentication separately before use. Render-time context invalidation plus request IDs prevent old-brand/old-target requests repopulating the current result. New manual requests supersede old ones. Missing pages and duplicate period ad rows fail closed rather than silently undercounting.

## Verification

Run `node --test tests/*.test.cjs` (Node 22+). Tests use fixtures only: six decisions, diagnosis/confidence, empty/low-data, purchase dedup, zero ROAS, calendar/DST, sorting, pagination, optional field failures, manual history, failed history, cross-brand requests and server permissions.

JSX validated using the same Babel standalone compiler as the site, both before and after the existing Cloudflare HTML middleware. Middleware remains `website-groups-v3`; weekly/monthly/daily/sponsor rendering code is unchanged.

Live H&J counts and token permissions must be checked from the preview using an authorized Meta token and team login. Never report fixture counts as live counts. Preview is separate from production; existing Cloudflare branch-preview integration is used, with no main merge or production deployment.
