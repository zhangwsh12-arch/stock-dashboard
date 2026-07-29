"""AI 解读：DeepSeek(OpenAI 兼容) 翻译非中文推文 + 每账号话题标签 + 周趋势合成。
接口可插拔：LLM_API_BASE / LLM_API_KEY / LLM_MODEL。无 key 时降级为原文直出。"""
import json
import os

from common import log


def _llm_config():
    return {
        "base": os.getenv("LLM_API_BASE", "https://api.deepseek.com").rstrip("/"),
        "key": os.getenv("LLM_API_KEY", ""),
        "model": os.getenv("LLM_MODEL", "deepseek-chat"),
    }


def _chat(messages: list[dict], temperature: float = 0.3, max_tokens: int = 1500) -> str | None:
    cfg = _llm_config()
    if not cfg["key"]:
        return None
    import requests
    try:
        r = requests.post(
            f"{cfg['base']}/chat/completions",
            headers={"Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json"},
            json={"model": cfg["model"], "messages": messages,
                  "temperature": temperature, "max_tokens": max_tokens},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:  # noqa
        log.warning("LLM 调用失败，降级为原文: %s", e)
        return None


def interpret_daily(fetch_result: dict) -> dict:
    """给每条非中文推文加中文译文；给每个账号加一句话话题概括。"""
    for acc in fetch_result["accounts"]:
        items = acc["items"]
        # 1) 批量翻译非中文推文
        to_translate = [it for it in items if (it.get("lang") or "").lower() not in ("zh", "zh-cn", "zh-tw", "")]
        if to_translate:
            payload = [{"i": idx, "text": it["text"][:500]} for idx, it in enumerate(to_translate)]
            content = _chat([
                {"role": "system", "content": "你是专业的社交媒体翻译。将每条推文翻译成自然流畅的简体中文，保留专有名词与话题标签。只返回 JSON 数组，格式 [{\"i\":序号,\"zh\":\"译文\"}]，不要多余文字。"},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ])
            trans_map = {}
            if content:
                try:
                    for row in json.loads(content[content.find("["):content.rfind("]") + 1]):
                        trans_map[row["i"]] = row["zh"]
                except Exception as e:  # noqa
                    log.warning("翻译解析失败: %s", e)
            for idx, it in enumerate(to_translate):
                if idx in trans_map:
                    it["text_zh"] = trans_map[idx]
        # 2) 账号话题概括
        if items:
            joined = "\n".join(f"- [{it['kind']}] {it.get('text_zh') or it['text']}" for it in items[:20])
            topic = _chat([
                {"role": "system", "content": "你是敏锐的行业观察者。用一句不超过40字的简体中文概括该账号今日在关注/讨论什么。只返回这句话本身。"},
                {"role": "user", "content": f"账号 @{acc['handle']} 今日内容：\n{joined}"},
            ], max_tokens=120)
            acc["topic"] = topic or ""
        else:
            acc["topic"] = "今日无更新"
    return fetch_result


def interpret_weekly(daily_snapshots: list[dict]) -> str:
    """基于近 7 日快照做趋势合成，返回完整段落形式的中文分析。"""
    # 汇总每账号一周内容
    by_account: dict[str, list[str]] = {}
    for snap in daily_snapshots:
        for acc in snap.get("accounts", []):
            key = f"@{acc['handle']} ({acc['name']})"
            for it in acc.get("items", []):
                txt = it.get("text_zh") or it.get("text") or ""
                if txt:
                    by_account.setdefault(key, []).append(f"[{it['kind']}] {txt[:200]}")
    if not by_account:
        return "本周监控的账号无新增内容。"
    blocks = []
    for k, msgs in by_account.items():
        blocks.append(f"### {k}\n" + "\n".join(msgs[:40]))
    corpus = "\n\n".join(blocks)
    analysis = _chat([
        {"role": "system", "content": (
            "你是资深的游戏行业与舆情分析师。基于给定的一周社媒内容，写一份中文周度趋势分析。"
            "要求：分账号写成完整段落（不要用表格、不要用生硬的要点符号堆砌），"
            "指出每个账号本周关注的核心话题、反复出现的主题、值得留意的信号；"
            "最后用一段做整体趋势总结。语言精炼、干货、可直接阅读。"
        )},
        {"role": "user", "content": corpus[:12000]},
    ], temperature=0.4, max_tokens=2500)
    return analysis or "（未配置 LLM，以下为本周原始内容汇总）\n\n" + corpus
