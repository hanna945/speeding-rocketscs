#!/usr/bin/env python3
"""Fast Meta creative thumbnail repair.

This job deliberately does NOT fetch Insights, attribution, delivery status, campaigns,
ad sets, revenue, CPA or ROAS. It only refreshes creative thumbnail/image URLs for ad IDs
already present in recent persisted month reports, then patches those image fields in KV.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

DEFAULT_BASE_URL = "https://speedingscs.pages.dev"
MONTHS_TO_REPAIR = 6
_OIDC_CACHE = {"token": "", "exp": 0}


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _jwt_exp(token: str) -> int:
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(part.encode("ascii")).decode("utf-8"))
        return int(payload.get("exp") or 0)
    except Exception:
        return 0


def github_oidc_token() -> str:
    now = int(datetime.now(timezone.utc).timestamp())
    if _OIDC_CACHE["token"] and _OIDC_CACHE["exp"] - now > 120:
        return str(_OIDC_CACHE["token"])

    request_url = os.getenv("ACTIONS_ID_TOKEN_REQUEST_URL", "").strip()
    request_token = os.getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "").strip()
    if not request_url or not request_token:
        raise RuntimeError("GitHub OIDC environment is unavailable.")

    sep = "&" if "?" in request_url else "?"
    url = request_url + sep + urllib.parse.urlencode({"audience": "speedingscs-airbyte"})
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + request_token,
            "Accept": "application/json",
            "User-Agent": "speedingscs-thumbnail-repair/1.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    token = str(payload.get("value") or "").strip()
    if not token:
        raise RuntimeError("GitHub OIDC endpoint returned no token.")
    _OIDC_CACHE["token"] = token
    _OIDC_CACHE["exp"] = _jwt_exp(token)
    return token


def machine_json(url: str, method: str = "GET", payload: Any = None) -> Any:
    body = None
    headers = {
        "Authorization": "Bearer " + github_oidc_token(),
        "Accept": "application/json",
        "User-Agent": "speedingscs-thumbnail-repair/1.0",
    }
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
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
        payload = machine_json(kv_url(base_url, key))
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
    headers = {
        "Authorization": "Bearer " + github_oidc_token(),
        "Accept": "application/json",
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "speedingscs-thumbnail-repair/1.0",
    }
    req = urllib.request.Request(kv_url(base_url, key), data=raw, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        raw_error = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} writing KV: {raw_error[:500]}") from exc


def fetch_brands(base_url: str) -> list[dict[str, str]]:
    payload = machine_json(base_url.rstrip("/") + "/api/airbyte/brands")
    brands = payload.get("brands") if isinstance(payload, dict) else []
    out: list[dict[str, str]] = []
    for item in brands or []:
        if not isinstance(item, dict):
            continue
        brand_id = str(item.get("id") or "").strip().removeprefix("act_")
        if brand_id:
            out.append({"id": brand_id, "name": str(item.get("name") or brand_id)})
    return out


def month_keys(months: int = MONTHS_TO_REPAIR) -> list[str]:
    today = (datetime.now(timezone.utc) + timedelta(hours=8)).date()
    out = []
    year, month = today.year, today.month
    for _ in range(max(1, months)):
        out.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month <= 0:
            month = 12
            year -= 1
    return out


def report_key(account_id: str, month: str) -> str:
    return f"metaads-month:{account_id}::{month}"


def progress(base_url: str, request_id: str, brands: list[dict[str, Any]], completed: int, current: dict[str, str] | None, message: str) -> None:
    if not request_id:
        return
    try:
        machine_json(
            base_url.rstrip("/") + "/api/airbyte/sync",
            method="POST",
            payload={
                "action": "progress",
                "requestId": request_id,
                "brands": brands,
                "completed": completed,
                "total": len(brands),
                "currentBrand": current,
                "message": message,
            },
        )
    except Exception as exc:
        print(f"WARNING progress update failed: {exc}", file=sys.stderr)


def fetch_fresh_images(account_id: str, ad_ids: list[str]) -> dict[str, str]:
    token = env_required("META_SYSTEM_USER_TOKEN")
    result: dict[str, str] = {}
    unique_ids = list(dict.fromkeys(str(x) for x in ad_ids if x))
    base = "https://graph.facebook.com/v19.0/act_" + account_id + "/ads"

    for start in range(0, len(unique_ids), 50):
        chunk = unique_ids[start:start + 50]
        params = {
            "fields": "id,creative{id,thumbnail_url,image_url}",
            "filtering": json.dumps([{"field": "id", "operator": "IN", "value": chunk}], separators=(",", ":")),
            "limit": "500",
            "access_token": token,
        }
        url = base + "?" + urllib.parse.urlencode(params)
        pages = 0
        while url and pages < 3:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "speedingscs-thumbnail-repair/1.0"})
            with urllib.request.urlopen(req, timeout=45) as response:
                payload = json.loads(response.read().decode("utf-8"))
            for row in payload.get("data") or []:
                ad_id = str(row.get("id") or "")
                creative = row.get("creative") if isinstance(row.get("creative"), dict) else {}
                image = str(creative.get("thumbnail_url") or creative.get("image_url") or "").strip()
                if ad_id and image:
                    result[ad_id] = image
            url = ((payload.get("paging") or {}).get("next")) or ""
            pages += 1
    return result


def patch_report(record: dict[str, Any], image_by_ad: dict[str, str]) -> tuple[dict[str, Any], int]:
    out = dict(record)
    changed = 0

    raw_ads = []
    for source in out.get("rawAds") or []:
        if not isinstance(source, dict):
            raw_ads.append(source)
            continue
        row = dict(source)
        image = image_by_ad.get(str(row.get("adId") or ""))
        if image and row.get("image") != image:
            row["image"] = image
            changed += 1
        raw_ads.append(row)
    out["rawAds"] = raw_ads

    ads = []
    for source in out.get("ads") or []:
        if not isinstance(source, dict):
            ads.append(source)
            continue
        row = dict(source)
        image = ""
        for ad_id in row.get("adIds") or []:
            image = image_by_ad.get(str(ad_id)) or ""
            if image:
                break
        if image and row.get("image") != image:
            row["image"] = image
        ads.append(row)
    out["ads"] = ads

    out["thumbnailMetadataSyncedAt"] = datetime.now(timezone.utc).isoformat()
    out["thumbnailRefreshMode"] = "thumbnail_only"
    return out, changed


def repair_brand(base_url: str, brand: dict[str, str], months: int) -> tuple[int, int, int]:
    account_id = brand["id"]
    records: list[tuple[str, dict[str, Any]]] = []
    ad_ids: list[str] = []

    for month in month_keys(months):
        key = report_key(account_id, month)
        record = kv_get(base_url, key)
        if not isinstance(record, dict):
            continue
        records.append((key, record))
        for row in record.get("rawAds") or []:
            if isinstance(row, dict) and row.get("adId"):
                ad_ids.append(str(row["adId"]))

    unique_ids = list(dict.fromkeys(ad_ids))
    if not unique_ids:
        return 0, 0, len(records)

    images = fetch_fresh_images(account_id, unique_ids)
    patched_rows = 0
    for key, record in records:
        patched, changed = patch_report(record, images)
        if changed:
            kv_put(base_url, key, patched)
            patched_rows += changed

    return len(unique_ids), patched_rows, len(records)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", default="")
    parser.add_argument("--brand-id", default="")
    parser.add_argument("--months", type=int, default=MONTHS_TO_REPAIR)
    args = parser.parse_args()

    env_required("META_SYSTEM_USER_TOKEN")
    base_url = os.getenv("REPORT_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
    github_oidc_token()

    brands = fetch_brands(base_url)
    if args.brand_id:
        wanted = args.brand_id.removeprefix("act_")
        brands = [b for b in brands if b["id"] == wanted]
    if not brands:
        raise RuntimeError("No brands available for thumbnail repair.")

    rows = [{"id": b["id"], "name": b["name"], "status": "waiting", "message": ""} for b in brands]
    completed = 0
    errors: list[tuple[dict[str, str], Exception]] = []
    progress(base_url, args.request_id, rows, completed, None, f"準備修復 {len(brands)} 個品牌素材縮圖")

    for index, brand in enumerate(brands):
        rows[index]["status"] = "running"
        rows[index]["message"] = "修復縮圖中"
        progress(base_url, args.request_id, rows, completed, brand, f"正在修復 {brand['name']} 素材縮圖")
        try:
            ads_count, patched_count, reports_count = repair_brand(base_url, brand, args.months)
            rows[index]["status"] = "done"
            rows[index]["message"] = f"完成：{patched_count} 張縮圖 / {ads_count} 支廣告"
            completed += 1
            print(f"[{brand['name']}] reports={reports_count}, ads={ads_count}, patched={patched_count}")
        except Exception as exc:
            errors.append((brand, exc))
            rows[index]["status"] = "error"
            rows[index]["message"] = str(exc)[:260]
            print(f"ERROR [{brand['name']}]: {exc}", file=sys.stderr)
        next_brand = brands[index + 1] if index + 1 < len(brands) else None
        progress(base_url, args.request_id, rows, completed, next_brand, f"已完成 {completed}/{len(brands)} 個品牌")

    if errors:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
