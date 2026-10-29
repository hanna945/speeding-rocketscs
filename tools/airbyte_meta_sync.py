#!/usr/bin/env python3
"""Centralized Meta Ads sync for the brand report using Airbyte's Facebook Marketing Agent connector.

The sync is deliberately READ ONLY against Meta. It writes normalized snapshots into the
same Cloudflare KV keys that the existing report already reads:
  metaads-month:<brandId>::YYYY-MM
  metaads-week:<brandId>::YYYY-MM-DD

It also keeps private incremental cache keys:
  airbyte-cache:<brandId>::YYYY-MM
  airbyte-meta:<brandId>

The browser-side direct Meta API path remains available as a fallback.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from airbyte_agent_sdk.connectors.facebook_marketing import FacebookMarketingConnector
from airbyte_agent_sdk.connectors.facebook_marketing.models import (
    FacebookMarketingServiceAccountKeyAuthenticationAuthConfig,
)

PURCHASE_ACTION_PRIORITY = [
    "omni_purchase",
    "purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_web_purchase",
    "onsite_web_app_purchase",
]
MIN_FETCH_SPEND = 500.0
DEFAULT_BASE_URL = "https://speedingscs.pages.dev"


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


_OIDC_CACHE = {"token": "", "exp": 0}


def _jwt_exp(token: str) -> int:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(part.encode("ascii")).decode("utf-8"))
        return int(payload.get("exp") or 0)
    except Exception:
        return 0


def github_oidc_token() -> str:
    """Request a short-lived GitHub Actions OIDC token for the Cloudflare machine gateway."""
    now = int(datetime.now(timezone.utc).timestamp())
    if _OIDC_CACHE["token"] and _OIDC_CACHE["exp"] - now > 120:
        return str(_OIDC_CACHE["token"])

    request_url = os.getenv("ACTIONS_ID_TOKEN_REQUEST_URL", "").strip()
    request_token = os.getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "").strip()
    if not request_url or not request_token:
        raise RuntimeError("GitHub OIDC environment is unavailable. Workflow needs permissions: id-token: write.")

    sep = "&" if "?" in request_url else "?"
    url = request_url + sep + urllib.parse.urlencode({"audience": "speedingscs-airbyte"})
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + request_token,
            "Accept": "application/json",
            "User-Agent": "speedingscs-airbyte-sync/2.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Unable to obtain GitHub OIDC token: HTTP {exc.code}: {raw[:400]}") from exc

    token = str(payload.get("value") or "").strip()
    if not token:
        raise RuntimeError("GitHub OIDC endpoint returned no token.")

    _OIDC_CACHE["token"] = token
    _OIDC_CACHE["exp"] = _jwt_exp(token)
    return token

def dump_model(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return [dump_model(v) for v in value]
    return value


def unpack_envelope(value: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    obj = dump_model(value)
    if not isinstance(obj, dict):
        return [], {}
    data = obj.get("data", [])
    meta = obj.get("meta", {}) or {}
    if isinstance(data, dict) and "data" in data:
        meta = data.get("meta", meta) or {}
        data = data.get("data", [])
    if not isinstance(data, list):
        data = [data] if isinstance(data, dict) and data else []
    return [x for x in data if isinstance(x, dict)], meta if isinstance(meta, dict) else {}


def single_record(value: Any) -> dict[str, Any]:
    obj = dump_model(value)
    if not isinstance(obj, dict):
        return {}
    if isinstance(obj.get("data"), dict):
        return obj["data"]
    data = obj.get("data")
    if isinstance(data, list):
        return data[0] if data else {}
    return obj


async def paged(method, **params: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    after: str | None = None
    seen: set[str] = set()
    while True:
        kwargs = dict(params)
        if after:
            kwargs["after"] = after
        result = await method(**kwargs)
        page, meta = unpack_envelope(result)
        rows.extend(page)
        next_after = meta.get("after")
        if not next_after or next_after in seen:
            break
        seen.add(str(next_after))
        after = str(next_after)
    return rows


def http_json(url: str, method: str = "GET", body: bytes | None = None) -> Any:
    headers = {
        "Authorization": "Bearer " + github_oidc_token(),
        "Accept": "application/json",
        "User-Agent": "speedingscs-airbyte-sync/2.0",
    }
    if body is not None:
        headers["Content-Type"] = "text/plain; charset=utf-8"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {raw[:500]}") from exc


def kv_url(base_url: str, key: str) -> str:
    return base_url.rstrip("/") + "/api/airbyte/kv/item/" + urllib.parse.quote(key, safe="")


def kv_get(base_url: str, key: str) -> Any:
    try:
        payload = http_json(kv_url(base_url, key))
    except RuntimeError as exc:
        if "HTTP 404" in str(exc):
            return None
        raise
    if not isinstance(payload, dict) or "value" not in payload:
        return None
    try:
        return json.loads(payload["value"])
    except Exception:
        return payload["value"]


def kv_put(base_url: str, key: str, value: Any) -> None:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    http_json(kv_url(base_url, key), method="PUT", body=raw)


def fetch_brand_roster(base_url: str) -> list[dict[str, str]]:
    payload = http_json(base_url.rstrip("/") + "/api/airbyte/brands")
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(f"Unable to load brand roster: {payload}")
    brands = payload.get("brands") or []
    out = []
    for brand in brands:
        if not isinstance(brand, dict):
            continue
        brand_id = str(brand.get("id") or "").strip().removeprefix("act_")
        if brand_id:
            out.append({"id": brand_id, "name": str(brand.get("name") or brand_id)})
    return out


def as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def as_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


def pick_action(actions: Any, types: list[str]) -> float:
    if not isinstance(actions, list):
        return 0.0
    for action_type in types:
        for entry in actions:
            if isinstance(entry, dict) and entry.get("action_type") == action_type:
                return as_float(entry.get("value"))
    return 0.0


def pick_purchase(actions: Any) -> float:
    return pick_action(actions, PURCHASE_ACTION_PRIORITY)


def extract_utm_from_url(url: str) -> str:
    if not url:
        return ""
    try:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        for key in ("utm_content", "utm_medium", "utm_campaign", "utm_source"):
            values = query.get(key)
            if values and values[0]:
                return str(values[0]).strip()
    except Exception:
        return ""
    return ""


def month_key(day: date) -> str:
    return day.strftime("%Y-%m")


def days_between(since: date, until: date) -> list[date]:
    if since > until:
        return []
    return [since + timedelta(days=i) for i in range((until - since).days + 1)]


def last_completed_week(today: date) -> tuple[date, date]:
    this_monday = today - timedelta(days=today.weekday())
    last_sunday = this_monday - timedelta(days=1)
    last_monday = last_sunday - timedelta(days=6)
    return last_monday, last_sunday


def cache_key(account_id: str, mk: str) -> str:
    return f"airbyte-cache:{account_id}::{mk}"


def meta_key(account_id: str) -> str:
    return f"airbyte-meta:{account_id}"


def month_report_key(account_id: str, mk: str) -> str:
    return f"metaads-month:{account_id}::{mk}"


def week_report_key(account_id: str, week_start: str) -> str:
    return f"metaads-week:{account_id}::{week_start}"


def legacy_ad_meta(existing: Any) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(existing, dict):
        return out
    for row in existing.get("rawAds") or []:
        if isinstance(row, dict) and row.get("adId"):
            out[str(row["adId"])] = dict(row)
    for row in existing.get("ads") or []:
        if not isinstance(row, dict):
            continue
        for ad_id in row.get("adIds") or []:
            item = out.setdefault(str(ad_id), {})
            for key in ("utm", "image", "postId", "postPublishDate", "startDate"):
                if row.get(key) and not item.get(key):
                    item[key] = row.get(key)
    return out


async def refresh_metadata(
    connector: FacebookMarketingConnector,
    account_id: str,
    old_meta: dict[str, Any] | None,
    max_age_hours: int,
) -> dict[str, Any]:
    old_meta = old_meta if isinstance(old_meta, dict) else {}
    synced_at = old_meta.get("syncedAt")
    if synced_at:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(str(synced_at).replace("Z", "+00:00"))
            if age.total_seconds() < max_age_hours * 3600:
                return old_meta
        except Exception:
            pass

    campaigns = await paged(
        connector.campaigns.list,
        account_id=account_id,
        fields="id,name,objective,effective_status,status,start_time,created_time",
        limit=500,
    )
    adsets = await paged(
        connector.ad_sets.list,
        account_id=account_id,
        fields="id,name,campaign_id,effective_status,start_time,created_time,optimization_goal,learning_stage_info",
        limit=500,
    )
    ads = await paged(
        connector.ads.list,
        account_id=account_id,
        fields="id,name,adset_id,campaign_id,configured_status,effective_status,created_time,creative,status,tracking_specs",
        limit=500,
    )
    creatives = await paged(
        connector.ad_creatives.list,
        account_id=account_id,
        fields="id,name,thumbnail_url,image_url,link_url,status",
        limit=500,
    )

    return {
        "syncedAt": datetime.now(timezone.utc).isoformat(),
        "campaigns": {str(x.get("id")): x for x in campaigns if x.get("id")},
        "adsets": {str(x.get("id")): x for x in adsets if x.get("id")},
        "ads": {str(x.get("id")): x for x in ads if x.get("id")},
        "creatives": {str(x.get("id")): x for x in creatives if x.get("id")},
    }


async def fetch_daily_insights(
    connector: FacebookMarketingConnector,
    account_id: str,
    since: date,
    until: date,
) -> list[dict[str, Any]]:
    if since > until:
        return []
    return await paged(
        connector.ads_insights.list,
        account_id=account_id,
        fields="account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,clicks,impressions,reach,spend,date_start,date_stop,actions,action_values",
        time_range=json.dumps({"since": since.isoformat(), "until": until.isoformat()}),
        level="ad",
        time_increment="1",
        limit=500,
    )


async def fetch_period_reach(
    connector: FacebookMarketingConnector,
    account_id: str,
    since: date,
    until: date,
) -> dict[str, float]:
    rows = await paged(
        connector.ads_insights.list,
        account_id=account_id,
        fields="ad_id,reach",
        time_range=json.dumps({"since": since.isoformat(), "until": until.isoformat()}),
        level="ad",
        limit=500,
    )
    return {str(r.get("ad_id")): as_float(r.get("reach")) for r in rows if r.get("ad_id")}


def update_cache_rows(
    caches: dict[str, dict[str, Any]],
    account_id: str,
    since: date,
    until: date,
    rows: list[dict[str, Any]],
) -> None:
    by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        day = str(row.get("date_start") or "")
        if day:
            by_day[day].append(row)

    for day in days_between(since, until):
        mk = month_key(day)
        cache = caches.setdefault(mk, {"version": 1, "accountId": account_id, "month": mk, "days": {}})
        if not isinstance(cache.get("days"), dict):
            cache["days"] = {}
        cache["days"][day.isoformat()] = by_day.get(day.isoformat(), [])
        cache["updatedAt"] = datetime.now(timezone.utc).isoformat()


def rows_for_period(caches: dict[str, dict[str, Any]], since: date, until: date) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for day in days_between(since, until):
        cache = caches.get(month_key(day), {})
        day_rows = (cache.get("days") or {}).get(day.isoformat(), [])
        if isinstance(day_rows, list):
            rows.extend(x for x in day_rows if isinstance(x, dict))
    return rows


def build_report_record(
    rows: list[dict[str, Any]],
    reach_by_ad: dict[str, float],
    metadata: dict[str, Any],
    legacy: dict[str, dict[str, Any]],
    account_id: str,
    currency: str,
    since: date,
    until: date,
    relax_threshold: bool,
) -> dict[str, Any]:
    campaigns = metadata.get("campaigns") or {}
    adsets = metadata.get("adsets") or {}
    ads_meta = metadata.get("ads") or {}
    creatives = metadata.get("creatives") or {}

    totals = {"spend": 0.0, "conversions": 0.0, "revenue": 0.0, "impressions": 0, "clicks": 0, "linkClicks": 0}
    per_ad: dict[str, dict[str, Any]] = {}
    sponsor: dict[str, dict[str, Any]] = {}

    for row in rows:
        ad_id = str(row.get("ad_id") or "")
        if not ad_id:
            continue
        spend = as_float(row.get("spend"))
        conversions = pick_purchase(row.get("actions"))
        revenue = pick_purchase(row.get("action_values"))
        impressions = as_int(row.get("impressions"))
        clicks = as_int(row.get("clicks"))
        link_clicks = int(pick_action(row.get("actions"), ["link_click", "outbound_click"])) or clicks
        totals["spend"] += spend
        totals["conversions"] += conversions
        totals["revenue"] += revenue
        totals["impressions"] += impressions
        totals["clicks"] += clicks
        totals["linkClicks"] += link_clicks

        item = per_ad.setdefault(ad_id, {
            "name": row.get("ad_name") or "(未命名廣告)",
            "adId": ad_id,
            "campaignId": str(row.get("campaign_id") or ""),
            "campaign": row.get("campaign_name") or "(未分類活動)",
            "adSetId": str(row.get("adset_id") or ""),
            "adSet": row.get("adset_name") or "(未分類廣告組合)",
            "spend": 0.0, "conversions": 0.0, "revenue": 0.0,
            "impressions": 0, "clicks": 0, "linkClicks": 0, "landingPageViews": 0.0,
        })
        item["spend"] += spend
        item["conversions"] += conversions
        item["revenue"] += revenue
        item["impressions"] += impressions
        item["clicks"] += clicks
        item["linkClicks"] += link_clicks
        item["landingPageViews"] += pick_action(row.get("actions"), ["landing_page_view", "omni_landing_page_view"])

        campaign_name = str(row.get("campaign_name") or "")
        ad_name = str(row.get("ad_name") or "")
        if "業配" in campaign_name or "業配" in ad_name:
            s = sponsor.setdefault(ad_id, {
                "name": ad_name or "(未命名廣告)",
                "adId": ad_id,
                "campaign": campaign_name or "(未分類活動)",
                "spend": 0.0, "conversions": 0.0, "revenue": 0.0,
            })
            s["spend"] += spend
            s["conversions"] += conversions
            s["revenue"] += revenue

    raw_ads = []
    for ad_id, item in per_ad.items():
        ad_meta = ads_meta.get(ad_id) or {}
        campaign_meta = campaigns.get(item.get("campaignId")) or {}
        adset_meta = adsets.get(item.get("adSetId")) or {}
        legacy_meta = legacy.get(ad_id) or {}
        creative_obj = ad_meta.get("creative") if isinstance(ad_meta.get("creative"), dict) else {}
        creative_id = str((creative_obj or {}).get("id") or legacy_meta.get("creativeId") or "")
        creative = creatives.get(creative_id) or {}
        image = creative.get("thumbnail_url") or creative.get("image_url") or legacy_meta.get("image") or ""
        utm = legacy_meta.get("utm") or extract_utm_from_url(str(creative.get("link_url") or ""))
        effective_status = str(ad_meta.get("effective_status") or legacy_meta.get("effectiveStatus") or "UNKNOWN")
        campaign_status = str(campaign_meta.get("effective_status") or legacy_meta.get("campaignEffectiveStatus") or "UNKNOWN")
        active = effective_status == "ACTIVE"
        if not (item["spend"] >= MIN_FETCH_SPEND or (relax_threshold and active)):
            continue

        raw_ads.append({
            **item,
            "campaign": item.get("campaign") or campaign_meta.get("name") or "(未分類活動)",
            "adSet": item.get("adSet") or adset_meta.get("name") or "(未分類廣告組合)",
            "objective": campaign_meta.get("objective") or legacy_meta.get("objective") or "",
            "campaignEffectiveStatus": campaign_status,
            "campaignActive": campaign_status == "ACTIVE",
            "optimizationGoal": adset_meta.get("optimization_goal") or legacy_meta.get("optimizationGoal") or "",
            "creativeId": creative_id,
            "postId": legacy_meta.get("postId") or "",
            "utm": utm,
            "image": image,
            "active": active,
            "startDate": adset_meta.get("start_time") or ad_meta.get("created_time") or legacy_meta.get("startDate"),
            "postPublishDate": legacy_meta.get("postPublishDate"),
            "reach": reach_by_ad.get(ad_id, 0.0),
        })

    grouped: dict[str, dict[str, Any]] = {}
    for ad in raw_ads:
        key = (
            ("utm:" + ad["utm"] if ad.get("utm") else "ad:" + ad["adId"])
            + "::campaign:" + str(ad.get("campaign") or "")
            + "::adset:" + str(ad.get("adSet") or "")
            + "::" + ("on" if ad.get("active") else "off")
        )
        g = grouped.setdefault(key, {
            "utm": ad.get("utm") or "",
            "names": set(), "image": "", "postId": "",
            "spend": 0.0, "conversions": 0.0, "revenue": 0.0,
            "impressions": 0, "clicks": 0, "linkClicks": 0, "reach": 0.0,
            "active": bool(ad.get("active")), "campaigns": set(), "adSets": set(),
            "adSetIds": set(), "adIds": set(), "startDate": None, "postPublishDate": None,
        })
        g["names"].add(ad.get("name") or "(未命名廣告)")
        g["spend"] += as_float(ad.get("spend"))
        g["conversions"] += as_float(ad.get("conversions"))
        g["revenue"] += as_float(ad.get("revenue"))
        g["impressions"] += as_int(ad.get("impressions"))
        g["clicks"] += as_int(ad.get("clicks"))
        g["linkClicks"] += as_int(ad.get("linkClicks"))
        g["reach"] += as_float(ad.get("reach"))
        g["campaigns"].add(ad.get("campaign") or "(未分類活動)")
        g["adSets"].add(ad.get("adSet") or "(未分類廣告組合)")
        if ad.get("adSetId"):
            g["adSetIds"].add(ad["adSetId"])
        g["adIds"].add(ad["adId"])
        if not g["image"] and ad.get("image"):
            g["image"] = ad["image"]
        if not g["postId"] and ad.get("postId"):
            g["postId"] = ad["postId"]
        for field in ("startDate", "postPublishDate"):
            value = ad.get(field)
            if value and (not g[field] or value < g[field]):
                g[field] = value

    ads = []
    for g in grouped.values():
        names = sorted(g.pop("names"))
        campaign_names = sorted(g.pop("campaigns"))
        adset_names = sorted(g.pop("adSets"))
        ad_ids = sorted(g.pop("adIds"))
        adset_ids = sorted(g.pop("adSetIds"))
        ads.append({
            **g,
            "name": names[0] if len(names) == 1 else (f"{names[0]} 等 {len(names)} 支廣告" if names else "未命名廣告"),
            "rawNames": names,
            "campaign": campaign_names[0] if len(campaign_names) == 1 else (f"{campaign_names[0]} 等 {len(campaign_names)} 個活動" if campaign_names else "(未分類活動)"),
            "adSet": adset_names[0] if len(adset_names) == 1 else (f"{adset_names[0]} 等 {len(adset_names)} 個廣告組合" if adset_names else "(未分類廣告組合)"),
            "adIds": ad_ids,
            "adSetIds": adset_ids,
            "adCount": len(ad_ids) or len(names) or 1,
        })
    ads.sort(key=lambda x: as_float(x.get("spend")), reverse=True)

    total_reach = sum(reach_by_ad.values())
    return {
        "spend": totals["spend"],
        "conversions": totals["conversions"],
        "revenue": totals["revenue"],
        "impressions": totals["impressions"],
        "clicks": totals["clicks"],
        "linkClicks": totals["linkClicks"],
        "reach": total_reach,
        "campaigns": len({str(r.get("campaign_id")) for r in rows if r.get("campaign_id")}),
        "currency": currency or "TWD",
        "accountId": account_id,
        "ads": ads,
        "rawAds": raw_ads,
        "sponsorAds": sorted(sponsor.values(), key=lambda x: x["spend"], reverse=True),
        "syncedAt": datetime.now(timezone.utc).isoformat(),
        "source": "airbyte",
        "requestedUntil": until.isoformat(),
        "effectiveUntil": until.isoformat(),
    }


async def sync_brand(
    connector: FacebookMarketingConnector,
    base_url: str,
    brand: dict[str, str],
    lookback_days: int,
    metadata_max_age_hours: int,
    force_backfill_days: int,
) -> None:
    account_id = brand["id"]
    account = single_record(await connector.ad_accounts.get(
        account_id=account_id,
        fields="id,account_id,name,currency,timezone_name,timezone_offset_hours_utc",
    ))
    offset = as_float(account.get("timezone_offset_hours_utc"))
    local_today = (datetime.now(timezone.utc) + timedelta(hours=offset)).date()
    currency = str(account.get("currency") or "TWD")
    current_month_start = local_today.replace(day=1)
    last_week_start, last_week_end = last_completed_week(local_today)

    needed_months = {month_key(current_month_start), month_key(last_week_start), month_key(last_week_end)}
    caches: dict[str, dict[str, Any]] = {}
    for mk in needed_months:
        cached = kv_get(base_url, cache_key(account_id, mk))
        caches[mk] = cached if isinstance(cached, dict) else {"version": 1, "accountId": account_id, "month": mk, "days": {}}

    current_cache = caches[month_key(current_month_start)]
    current_days = current_cache.get("days") if isinstance(current_cache.get("days"), dict) else {}
    if force_backfill_days > 0:
        query_since = max(current_month_start, local_today - timedelta(days=force_backfill_days - 1))
    elif current_days:
        query_since = max(current_month_start, local_today - timedelta(days=max(1, lookback_days) - 1))
    else:
        query_since = current_month_start

    print(f"[{brand['name']}] Airbyte insights {query_since} -> {local_today}")
    daily_rows = await fetch_daily_insights(connector, account_id, query_since, local_today)
    update_cache_rows(caches, account_id, query_since, local_today, daily_rows)

    missing_week_days = [
        d for d in days_between(last_week_start, last_week_end)
        if d.isoformat() not in ((caches.get(month_key(d), {}).get("days") or {}))
    ]
    if missing_week_days:
        week_rows = await fetch_daily_insights(connector, account_id, last_week_start, last_week_end)
        update_cache_rows(caches, account_id, last_week_start, last_week_end, week_rows)

    old_meta = kv_get(base_url, meta_key(account_id))
    metadata = await refresh_metadata(connector, account_id, old_meta, metadata_max_age_hours)
    if metadata is not old_meta:
        kv_put(base_url, meta_key(account_id), metadata)

    for mk, cache in caches.items():
        kv_put(base_url, cache_key(account_id, mk), cache)

    month_existing = kv_get(base_url, month_report_key(account_id, month_key(local_today)))
    legacy = legacy_ad_meta(month_existing)
    month_rows = rows_for_period(caches, current_month_start, local_today)
    month_reach = await fetch_period_reach(connector, account_id, current_month_start, local_today)
    month_record = build_report_record(
        month_rows, month_reach, metadata, legacy, account_id, currency,
        current_month_start, local_today, relax_threshold=False,
    )
    kv_put(base_url, month_report_key(account_id, month_key(local_today)), month_record)

    week_key = week_report_key(account_id, last_week_start.isoformat())
    week_existing = kv_get(base_url, week_key)
    if not isinstance(week_existing, dict) or week_existing.get("source") != "airbyte":
        week_rows = rows_for_period(caches, last_week_start, last_week_end)
        week_reach = await fetch_period_reach(connector, account_id, last_week_start, last_week_end)
        week_record = build_report_record(
            week_rows, week_reach, metadata, legacy_ad_meta(week_existing), account_id, currency,
            last_week_start, last_week_end, relax_threshold=True,
        )
        kv_put(base_url, week_key, week_record)

    print(
        f"[{brand['name']}] done: month ads={len(month_record['ads'])}, "
        f"spend={month_record['spend']:.2f}, source=airbyte"
    )


async def amain(args: argparse.Namespace) -> int:
    token = env_required("META_SYSTEM_USER_TOKEN")
    base_url = os.getenv("REPORT_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL

    # Fail early if GitHub OIDC is not available before touching Meta.
    github_oidc_token()

    connector = FacebookMarketingConnector(
        auth_config=FacebookMarketingServiceAccountKeyAuthenticationAuthConfig(account_key=token)
    )

    brands = fetch_brand_roster(base_url)
    if args.brand_id:
        wanted = args.brand_id.removeprefix("act_")
        brands = [b for b in brands if b["id"] == wanted]
    if not brands:
        raise RuntimeError("No brands returned by the machine-only Airbyte roster endpoint.")

    print(f"Central sync roster: {len(brands)} unique brand(s), auth=github_actions_oidc")
    errors = []
    for index, brand in enumerate(brands, start=1):
        print(f"({index}/{len(brands)}) {brand['name']} [{brand['id']}]")
        try:
            await sync_brand(
                connector, base_url, brand,
                lookback_days=args.lookback_days,
                metadata_max_age_hours=args.metadata_max_age_hours,
                force_backfill_days=args.backfill_days,
            )
        except Exception as exc:
            errors.append((brand, exc))
            print(f"ERROR [{brand['name']}]: {exc}", file=sys.stderr)
        if index < len(brands):
            await asyncio.sleep(args.brand_gap_seconds)

    if errors:
        print(f"{len(errors)} brand(s) failed:", file=sys.stderr)
        for brand, exc in errors:
            print(f"  - {brand['name']}: {exc}", file=sys.stderr)
        return 1
    return 0

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lookback-days", type=int, default=8, help="Refresh this many recent days for attribution changes.")
    parser.add_argument("--metadata-max-age-hours", type=int, default=24)
    parser.add_argument("--backfill-days", type=int, default=0, help="Manual override for current-month backfill window.")
    parser.add_argument("--brand-id", default="", help="Optional single account ID for manual debugging.")
    parser.add_argument("--brand-gap-seconds", type=float, default=3.0)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain(parse_args())))
