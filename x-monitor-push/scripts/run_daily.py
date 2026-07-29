"""日流程：抓取 → 解读 → 存快照 → 渲染看板（日报仅更新看板，不推送微信）。"""
from common import DAILY_DIR, kst_date_key, write_json, now_kst, log
from fetch import run_fetch
from interpret import interpret_daily
from render import render_daily


def main():
    date_key = kst_date_key()
    log.info("=== 日报流程开始 %s ===", date_key)

    result = run_fetch(window_hours=24)
    result = interpret_daily(result)

    daily = {
        "date": date_key,
        "generated_at": now_kst().isoformat(),
        "accounts": result["accounts"],
    }
    write_json(DAILY_DIR / f"{date_key}.json", daily)
    log.info("已保存快照 data/daily/%s.json", date_key)

    render_daily(daily)
    log.info("已渲染看板 docs/index.html（日报不推送微信，每周推送一次）")
    log.info("=== 日报流程结束 ===")


if __name__ == "__main__":
    main()
