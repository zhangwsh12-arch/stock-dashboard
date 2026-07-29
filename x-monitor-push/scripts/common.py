"""公共工具：配置加载、KST 时区、TwitterAPI.io 客户端、路径、日志。"""
import json
import os
import sys
import time
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------- 路径 ----------
ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
DAILY_DIR = DATA_DIR / "daily"
WEEKLY_DIR = DATA_DIR / "weekly"
DOCS_DIR = ROOT / "docs"
TEMPLATES_DIR = ROOT / "templates"
STATE_FILE = DATA_DIR / "state.json"

for d in (DAILY_DIR, WEEKLY_DIR, DOCS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ---------- 时区（KST = UTC+9）----------
KST = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    return datetime.now(KST)


def kst_date_key(dt: datetime | None = None) -> str:
    dt = dt or now_kst()
    return dt.astimezone(KST).strftime("%Y-%m-%d")


def kst_week_key(dt: datetime | None = None) -> str:
    dt = dt or now_kst()
    iso = dt.astimezone(KST).isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


# ---------- 日志 ----------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("xmonitor")


# ---------- 配置 ----------
def load_accounts() -> list[dict]:
    with open(CONFIG_DIR / "accounts.json", "r", encoding="utf-8") as f:
        return json.load(f)["accounts"]


def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# ---------- TwitterAPI.io 客户端 ----------
TWITTERAPI_BASE = "https://api.twitterapi.io"


class TwitterApiClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.getenv("TWITTERAPI_IO_KEY", "")
        self.session = None  # lazy import requests

    def _get(self, path: str, params: dict) -> dict:
        import requests
        if self.session is None:
            self.session = requests.Session()
        url = f"{TWITTERAPI_BASE}{path}"
        headers = {"X-API-Key": self.api_key}
        backoff = 2
        for attempt in range(5):
            try:
                r = self.session.get(url, headers=headers, params=params, timeout=20)
                if r.status_code == 429:
                    log.warning("429 限流，%ss 后重试 (第 %d 次)", backoff, attempt + 1)
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa
                if attempt == 4:
                    raise
                log.warning("请求失败 %s，%ss 后重试: %s", path, backoff, e)
                time.sleep(backoff)
                backoff *= 2
        return {}

    def last_tweets(self, user_name: str, cursor: str = "", include_replies: bool = False) -> dict:
        return self._get(
            "/twitter/user/last_tweets",
            {"userName": user_name, "cursor": cursor,
             "includeReplies": "true" if include_replies else "false"},
        )
