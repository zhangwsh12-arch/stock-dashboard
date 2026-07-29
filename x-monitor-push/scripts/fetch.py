"""抓取：调 last_tweets，24h 过滤 + 增量去重 + 分类(post/retweet/quote)。"""
from datetime import datetime, timedelta, timezone

from common import (
    TwitterApiClient, load_accounts, load_state, save_state,
    now_kst, log,
)

# X 的 createdAt 形如 "Tue Jul 22 05:12:33 +0000 2026"
TW_FMT = "%a %b %d %H:%M:%S %z %Y"


def parse_created_at(s: str) -> datetime | None:
    try:
        return datetime.strptime(s, TW_FMT)
    except Exception:
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None


def classify(t: dict) -> str:
    """原创 / 转发 / 引用。"""
    if t.get("retweeted_tweet"):
        return "retweet"
    if t.get("quoted_tweet"):
        return "quote"
    if t.get("isReply") and t.get("inReplyToUsername"):
        return "reply"
    return "post"


def simplify(t: dict, kind: str) -> dict:
    """精简保留报告/看板所需字段。"""
    author = t.get("author") or {}
    item = {
        "id": t.get("id"),
        "kind": kind,
        "url": t.get("url"),
        "text": (t.get("text") or "").strip(),
        "created_at": t.get("createdAt"),
        "lang": t.get("lang"),
        "metrics": {
            "like": t.get("likeCount", 0),
            "retweet": t.get("retweetCount", 0),
            "reply": t.get("replyCount", 0),
            "quote": t.get("quoteCount", 0),
            "view": t.get("viewCount", 0),
        },
        "author_handle": author.get("userName"),
    }
    # 转发/引用带上被转发/引用原文的关键信息
    for key, dst in (("retweeted_tweet", "source_tweet"), ("quoted_tweet", "source_tweet")):
        src = t.get(key)
        if isinstance(src, dict):
            src_author = src.get("author") or {}
            item[dst] = {
                "handle": src_author.get("userName"),
                "text": (src.get("text") or "").strip(),
                "url": src.get("url"),
            }
    return item


def fetch_account(client: TwitterApiClient, handle: str, last_seen_id: str | None,
                  since: datetime, max_pages: int = 5) -> tuple[list[dict], str | None]:
    collected: list[dict] = []
    cursor = ""
    newest_id = last_seen_id
    stop = False
    for _ in range(max_pages):
        resp = client.last_tweets(handle, cursor=cursor)
        tweets = resp.get("tweets") or []
        if not tweets:
            break
        for t in tweets:
            tid = t.get("id")
            if newest_id is None or (tid and tid > (newest_id or "")):
                # 记录本轮最大 id 作为新游标
                if collected == [] and tid:
                    pass
            # 命中上次已抓 → 停止（增量去重）
            if last_seen_id and tid and tid <= last_seen_id:
                stop = True
                break
            created = parse_created_at(t.get("createdAt", ""))
            if created and created < since:
                stop = True
                break
            kind = classify(t)
            collected.append(simplify(t, kind))
        if stop or not resp.get("has_next_page"):
            break
        cursor = resp.get("next_cursor") or ""
        if not cursor:
            break
    # 新游标 = 本次抓到的最大 id（tweets 已按时间倒序）
    if collected:
        max_id = max((c["id"] for c in collected if c.get("id")), default=newest_id)
        newest_id = max_id
    return collected, newest_id


def run_fetch(window_hours: int = 24) -> dict:
    accounts = load_accounts()
    state = load_state()
    client = TwitterApiClient()
    since = now_kst().astimezone(timezone.utc) - timedelta(hours=window_hours)

    result = {"accounts": []}
    for acc in accounts:
        handle = acc["handle"].lstrip("@")
        last_seen = (state.get(handle) or {}).get("last_seen_id")
        first_run = last_seen is None
        try:
            items, newest = fetch_account(client, handle, last_seen, since)
        except Exception as e:  # noqa
            log.error("抓取 @%s 失败: %s", handle, e)
            items, newest = [], last_seen
        if newest:
            state[handle] = {"last_seen_id": newest}
        counts = {"post": 0, "retweet": 0, "quote": 0, "reply": 0}
        for it in items:
            counts[it["kind"]] = counts.get(it["kind"], 0) + 1
        log.info("@%s: 新增 %d 条 %s%s", handle, len(items), counts,
                 " (首次建立基线)" if first_run else "")
        result["accounts"].append({
            "handle": handle,
            "name": acc.get("name", handle),
            "first_run": first_run,
            "counts": counts,
            "items": items,
        })
    save_state(state)
    return result


if __name__ == "__main__":
    import json
    print(json.dumps(run_fetch(), ensure_ascii=False, indent=2))
