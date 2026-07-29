"""周流程：聚合近 7 日快照 → 趋势合成 → 存周报 → 渲染 → 推送。"""
from common import (
    DAILY_DIR, WEEKLY_DIR, kst_week_key, read_json, write_json, now_kst, log,
)
from interpret import interpret_weekly
from render import render_weekly
from push import push, build_weekly_markdown


def load_last_n_daily(n: int = 7) -> list[dict]:
    files = sorted(DAILY_DIR.glob("*.json"), reverse=True)[:n]
    snaps = []
    for f in sorted(files):  # 升序便于阅读
        data = read_json(f)
        if data:
            snaps.append(data)
    return snaps


def main():
    week_key = kst_week_key()
    log.info("=== 周报流程开始 %s ===", week_key)

    snaps = load_last_n_daily(7)
    if not snaps:
        log.warning("无日报快照，跳过周报")
        return

    analysis = interpret_weekly(snaps)

    write_json(WEEKLY_DIR / f"{week_key}.json", {
        "week": week_key,
        "generated_at": now_kst().isoformat(),
        "days_covered": [s["date"] for s in snaps],
        "analysis": analysis,
    })
    log.info("已保存周报 data/weekly/%s.json", week_key)

    render_weekly(week_key, analysis)
    log.info("已渲染周报页")

    push(build_weekly_markdown(week_key, analysis))
    log.info("=== 周报流程结束 ===")


if __name__ == "__main__":
    main()
