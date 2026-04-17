"""
韩国游戏股价看板 - Web应用主程序
====================================
功能:
1. Flask后端API服务（动态数据渲染）
2. Naver Finance实时数据获取（PER/股价/市值等）
3. SQLite历史数据库（每日留档归档）
4. 定时任务：每天上午10点自动更新前一天数据
5. 历史日期查询接口

用法:
  python app.py                    # 启动Web服务 (默认 http://localhost:5000)
  python app.py --port 8080        # 指定端口
  python app.py --update-now       # 立即执行一次更新
  python app.py --init-db          # 初始化数据库并导入初始数据
"""

import os
import sys
import json
import argparse
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List, Any

import flask
from flask import Flask, render_template, jsonify, request, send_from_directory

# ============================================================
# 常量与配置
# ============================================================

KST = timezone(timedelta(hours=9))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "dashboard.db")

# 韩国主要游戏公司定义
COMPANIES: List[Dict[str, Any]] = [
    {"name_en": "Shift Up",    "name_ko": "시프트업",   "code": "391740", "color": "#ff6b9d", "market": "KOSDAQ", "is_focus": True},
    {"name_en": "Nexon",       "name_ko": "넥슨게임즈",  "code": "042700", "color": "#22c55e", "market": "KOSPI",  "is_focus": False},
    {"name_en": "Netmarble",   "name_ko": "넷마블",      "code": "251270", "color": "#ef4444", "market": "KOSDAQ", "is_focus": False},
    {"name_en": "NC",          "name_ko": "엔씨",          "code": "036570", "color": "#3b82f6", "market": "KOSDAQ", "is_focus": False},
    {"name_en": "Krafton",     "name_ko": "크래프톤",   "code": "259960", "color": "#f59e0b", "market": "KOSDAQ", "is_focus": False},
    {"name_en": "Pearl Abyss", "name_ko": "펄어비스",   "code": "263750", "color": "#ec4899", "market": "KOSDAQ", "is_focus": False},
]

# 日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger(__name__)

# ============================================================
# Flask 应用初始化
# ============================================================
app = Flask(__name__, template_folder=os.path.join(BASE_DIR, 'templates'),
           static_folder=os.path.join(BASE_DIR, 'static'))
app.config['JSON_AS_ASCII'] = False


# ============================================================
# SQLite 数据库层（历史留档）
# ============================================================

def get_db() -> sqlite3.Connection:
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """初始化数据库表结构"""
    os.makedirs(DATA_DIR, exist_ok=True)

    with get_db() as conn:
        # 每日收盘快照表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS daily_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_date TEXT NOT NULL UNIQUE,
                display_date TEXT NOT NULL,
                weekday TEXT NOT NULL,
                is_trading_day INTEGER DEFAULT 1,
                data_json TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now', '+9 hours')),
                updated_at TEXT DEFAULT (datetime('now', '+9 hours'))
            )
        ''')

        # 公司每日PER/估值指标表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS company_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_date TEXT NOT NULL,
                company_code TEXT NOT NULL,
                company_name TEXT NOT NULL,
                close_price INTEGER,
                change_rate REAL,
                per REAL,              -- 市盈率 (Price-to-Earnings)
                pbr REAL,              -- 市净率 (Price-to-Book)
                market_cap INTEGER,     -- 市值(韩元)
                foreign_holding_rate REAL,  -- 外资持股比例
                volume INTEGER,
                source TEXT DEFAULT 'naver',
                UNIQUE(trade_date, company_code),
                created_at TEXT DEFAULT (datetime('now', '+9 hours'))
            )
        ''')

        # 更新日志表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS update_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                executed_at TEXT NOT NULL,
                target_date TEXT NOT NULL,
                status TEXT NOT NULL,
                companies_updated INTEGER DEFAULT 0,
                error_msg TEXT,
                duration_seconds REAL
            )
        ''')
        
        conn.commit()
    
    log.info(f"✅ 数据库初始化完成: {DB_PATH}")


def save_daily_snapshot(trade_date: str, dashboard_data: dict) -> bool:
    """保存每日快照到数据库"""
    try:
        with get_db() as conn:
            dt = datetime.strptime(trade_date, "%Y%m%d")
            weekday_map = ["周一","周二","周三","周四","周五","周六","周日"]
            
            conn.execute('''
                INSERT OR REPLACE INTO daily_snapshots 
                (trade_date, display_date, weekday, is_trading_day, data_json, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now','+9 hours'))
            ''', (
                trade_date,
                f"{dt.year}年{dt.month}月{dt.day}日",
                weekday_map[dt.weekday()],
                1,
                json.dumps(dashboard_data, ensure_ascii=False)
            ))
            conn.commit()
        log.info(f"💾 快照已保存: {trade_date}")
        return True
    except Exception as e:
        log.error(f"❌ 保存快照失败: {e}")
        return False


def save_company_metrics(trade_date: str, metrics_list: list) -> int:
    """保存公司估值指标"""
    saved_count = 0
    try:
        with get_db() as conn:
            for m in metrics_list:
                conn.execute('''
                    INSERT OR REPLACE INTO company_metrics
                    (trade_date, company_code, company_name, close_price, change_rate,
                     per, pbr, market_cap, foreign_holding_rate, volume, source)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ''', (
                    trade_date,
                    m.get("code"),
                    m.get("name"),
                    m.get("close"),
                    m.get("change_rate"),
                    m.get("per"),
                    m.get("pbr"),
                    m.get("market_cap"),
                    m.get("foreign_rate"),
                    m.get("volume"),
                    m.get("source", "naver")
                ))
                saved_count += 1
            conn.commit()
        log.info(f"💾 估值指标已保存: {saved_count} 条 ({trade_date})")
    except Exception as e:
        log.error(f"❌ 保存估值指标失败: {e}")
    return saved_count


def get_available_dates() -> List[Dict]:
    """获取所有有数据的日期列表（用于前端日期选择器）"""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT trade_date, display_date, weekday FROM daily_snapshots ORDER BY trade_date DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_snapshot_by_date(trade_date: str) -> Optional[dict]:
    """获取指定日期的完整快照数据"""
    with get_db() as conn:
        row = conn.execute(
            "SELECT data_json FROM daily_snapshots WHERE trade_date=?", (trade_date,)
        ).fetchone()
    if row and row["data_json"]:
        return json.loads(row["data_json"])
    return None


def get_company_history(company_code: str, limit: int = 30) -> List[Dict]:
    """获取某公司最近N天的历史数据"""
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT trade_date, close_price, change_rate, per, pbr, market_cap 
               FROM company_metrics WHERE company_code=? 
               ORDER BY trade_date DESC LIMIT ?''',
            (company_code, limit)
        ).fetchall()
    return [dict(r) for r in rows]


# ============================================================
# Naver Finance 数据抓取（PER / 股价 / 市值）
# ============================================================

NAVER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
}


def fetch_naver_stock_info(code: str) -> Optional[Dict[str, Any]]:
    """
    从 Naver Finance 获取个股详细信息
    
    返回:
        {
            "close": 收盘价(int),
            "change_rate": 涨跌幅(float),
            "per": 市盈率(float),
            "pbr": 市净率(float),
            "market_cap_亿": 市值(亿韩元)(float),
            "foreign_rate": 外资持股比(float),
            "volume": 成交量(int),
            "high": 最高价(int),
            "low": 最低价(int),
            "open": 开盘价(int),
            "prev_close": 前日收盘(int),
        }
        或 None
    """
    import requests
    from bs4 import BeautifulSoup

    # Naver Finance 个股主页
    url = f"https://finance.naver.com/item/main.nhn?code={code}"
    
    try:
        resp = requests.get(url, headers=NAVER_HEADERS, timeout=15)
        resp.encoding = "euc-kr"
        soup = BeautifulSoup(resp.text, "lxml")
        
        result = {}
        
        # ---- 当日价格信息 (No Today) ----
        today_section = soup.select_one("div.today")
        if today_section:
            # 收盘价
            price_elem = today_section.select_one("p.no_today span.blind")
            if price_elem:
                raw = price_elem.get_text(strip=True).replace(",", "")
                result["close"] = int(raw)
            
            # 涨跌幅和涨跌额
            for elem in today_section.select("p.no_exday"):
                text = elem.get_text(strip=True)
                if "%" in text:
                    rate_str = text.replace("%", "").replace("+", "").strip().split()[0]
                    result["change_rate"] = float(rate_str)
            
            # 前日收盘
            prev_elem = today_section.select_one("td:first-child span.blind")
            if prev_elem:
                result["prev_close"] = int(prev_elem.get_text(strip=True).replace(",",""))
        
        # ---- 关键指标表格 (PER/PBR等) ----
        table = soup.select_one("table.summary_table") or soup.select_one("div.section.cop_analysis table")
        if not table:
            # 备选选择器
            tables = soup.select("table")
            for t in tables:
                cells = t.select("td")
                cell_texts = [c.get_text(strip=True) for c in cells]
                if any("PER" in t or "PBR" in t for t in cell_texts):
                    table = t
                    break
        
        if table:
            rows = table.find_all("tr")
            for row in rows:
                cells = row.find_all(["th", "td"])
                texts = [c.get_text(strip=True).replace(",", "") for c in cells]
                
                for i, txt in enumerate(texts):
                    upper = txt.upper()
                    if "PER(" in upper or upper == "PER":
                        if i + 1 < len(texts):
                            val = _parse_float(texts[i + 1])
                            if val is not None:
                                result["per"] = val
                    
                    elif "PBR(" in upper or upper == "PBR":
                        if i + 1 < len(texts):
                            val = _parse_float(texts[i + 1])
                            if val is not None:
                                result["pbr"] = val
        
        # ---- 外资持股比例 & 市值 ----
        # 在其他表格中查找
        all_tables = soup.select("table")
        for tbl in all_tables:
            rows = tbl.find_all("tr")
            for row in rows:
                cells = row.find_all(["th", "td"])
                texts = [c.get_text(strip=True).replace(",", "").replace("\xa0", "") for c in cells]
                combined = " ".join(texts).upper()
                
                if "외국인보유" in combined or "FOREIGN" in combined or "외국계" in combined:
                    for i, txt in enumerate(texts):
                        if "%" in txt:
                            result["foreign_rate"] = float(txt.replace("%", ""))
                        elif i > 0 and "%" in texts[i-1]:
                            result["foreign_rate"] = float(txt)
                
                # 시가총액 (市值)
                if "시가총액" in " ".join([c.get_text(strip=True) for c in cells]):
                    for i, txt in enumerate(texts):
                        clean = txt.strip().replace(",", "")
                        if clean.endswith("억") or clean.isdigit():
                            num_part = clean.replace("양", "").replace("조", "").replace("억", "")
                            val = _parse_float(num_part)
                            if val is not None:
                                if "조" in txt:
                                    result["market_cap_억"] = val * 10000  # 조 → 억
                                else:
                                    result["market_cap_억"] = val
        
        # ---- 高低价 / 成交量 ----
        for tbl in all_tables:
            rows = tbl.find_all("tr")
            for row in rows:
                cells = row.find_all(["th", "td"])
                texts = [c.get_text(strip=True).replace(",", "") for c in cells]
                
                for i, txt in enumerate(texts):
                    # 最高价
                    if txt == "고가" or txt.startswith("최고"):
                        if i + 1 < len(texts):
                            v = _parse_int(texts[i + 1])
                            if v: result["high"] = v
                    # 最低价
                    elif txt == "저가" or txt.startswith("최저"):
                        if i + 1 < len(texts):
                            v = _parse_int(texts[i + 1])
                            if v: result["low"] = v
                    # 开盘价
                    elif txt == "시가":
                        if i + 1 < len(texts):
                            v = _parse_int(texts[i + 1])
                            if v: result["open"] = v
                    # 成交量
                    elif txt == "거래량":
                        if i + 1 < len(texts):
                            v = _parse_int(texts[i + 1])
                            if v: result["volume"] = v

        if result.get("close"):
            result["source"] = "naver"
            return result
            
    except Exception as e:
        log.warning(f"Naver Finance 抓取失败 [{code}]: {e}")
    
    return None


def fetch_naver_market_index() -> Optional[Dict]:
    """获取 KOSPI/KOSDAQ 大盘指数"""
    import requests
    from bs4 import BeautifulSoup

    try:
        url = "https://finance.naver.com/sise/sise_index.naver?code=KPI200"
        resp = requests.get(url, headers=NAVER_HEADERS, timeout=10)
        resp.encoding = "euc-kr"
        soup = BeautifulSoup(resp.text, "lxml")
        
        # KOSPI 当前指数
        kospi_elem = soup.select_one("#value_KOSPI")
        kosdaq_elem = soup.select_one("#value_KOSDAQ")
        
        result = {}
        if kospi_elem:
            result["kospi"] = kospi_elem.get_text(strip=True).replace(",", "")
        if kosdaq_elem:
            result["kosdaq"] = kosdaq_elem.get_text(strip=True).replace(",", "")
        
        return result if result else None
    except Exception as e:
        log.warning(f"大盘指数获取失败: {e}")
        return None


def _parse_float(s: str) -> Optional[float]:
    """安全解析浮点数"""
    try:
        s = s.strip().replace("N/A", "").replace("-", "")
        if s == "" or s == "0":
            return 0.0
        return float(s)
    except (ValueError, TypeError):
        return None


def _parse_int(s: str) -> Optional[int]:
    """安全解析整数"""
    try:
        s = s.strip().replace("N/A", "").replace("-", "")
        if s == "":
            return None
        return int(float(s))
    except (ValueError, TypeError):
        return None


# ============================================================
# 数据聚合引擎（每日更新核心逻辑）
# ============================================================

class DataUpdater:
    """
    每日数据更新引擎
    1. 从 Naver Finance 抓取各公司实时数据（含PER）
    2. 汇总为看板数据包
    3. 存入 SQLite 历史数据库
    """

    def update(self, target_date_str: Optional[str] = None) -> Dict[str, Any]:
        """执行一次完整的数据更新"""
        start_time = datetime.now(KST)
        
        # 确定目标日期
        if target_date_str:
            target_dt = datetime.strptime(target_date_str, "%Y%m%d")
        else:
            # 默认取最近一个工作日
            now_kst = datetime.now(KST)
            target_dt = now_kst - timedelta(days=1)  # 默认前一天
            while target_dt.weekday() >= 5:  # 跳过周末
                target_dt -= timedelta(days=1)
        
        trade_date = target_dt.strftime("%Y%m%d")
        display_date = f"{target_dt.year}年{target_dt.month}月{target_dt.day}日"
        weekday_map = ["周一","周二","周三","周四","周五","周六","周日"]

        log.info(f"\n{'='*50}")
        log.info(f"🔄 开始更新数据 | 目标日期: {display_date} | 交易日: {trade_date}")
        log.info(f"{'='*50}\n")

        # ---- Step 1: 逐公司获取 Naver 数据 ----
        all_stocks = []
        metrics_list = []

        for comp in COMPANIES:
            code = comp["code"]
            name = comp["name_en"]
            
            log.info(f"  📡 获取 {name} ({comp['name_ko']}) [{code}] ...")
            
            info = fetch_naver_stock_info(code)
            
            stock_entry = {
                **comp,
                "price_data": info,
                "status": "ok" if info else "no_data",
            }
            all_stocks.append(stock_entry)

            if info:
                # 构造估值指标存库记录
                metric = {
                    "code": code,
                    "name": name,
                    "close": info.get("close", 0),
                    "change_rate": info.get("change_rate", 0),
                    "per": info.get("per"),
                    "pbr": info.get("pbr"),
                    "market_cap": info.get("market_cap_억"),
                    "foreign_rate": info.get("foreign_rate"),
                    "volume": info.get("volume", 0),
                    "source": "naver",
                }
                metrics_list.append(metric)
                
                per_val = info.get("per", "-")
                pbr_val = info.get("pbr", "-")
                cap_val = info.get("market_cap_억", "-")
                log.info(f"  ✅ ₩{info['close']:,} | PER={per_val} PBR={pbr_val} | 市值={cap_val}억")
            else:
                log.warning(f"  ❌ {name}: 数据获取失败")

        # ---- Step 2: 获取大盘指数 ----
        market_idx = fetch_naver_market_index()

        # ---- Step 3: 构建看板数据包 ----
        dashboard_data = {
            "meta": {
                "target_date": trade_date,
                "display_date": display_date,
                "weekday": weekday_map[target_dt.weekday()],
                "generated_at": start_time.isoformat(),
                "companies_total": len(COMPANIES),
                "companies_ok": sum(1 for s in all_stocks if s["status"] == "ok"),
            },
            "market_index": market_idx or {},
            "stocks": [],
            "per_summary": self._build_per_summary(all_stocks),
        }

        for s in all_stocks:
            pd_data = s.get("price_data") or {}
            dashboard_data["stocks"].append({
                "name_en": s["name_en"],
                "name_ko": s["name_ko"],
                "code": s["code"],
                "color": s["color"],
                "is_focus": s["is_focus"],
                "market": s["market"],
                "close": pd_data.get("close"),
                "prev_close": pd_data.get("prev_close"),
                "change_rate": pd_data.get("change_rate"),
                "high": pd_data.get("high"),
                "low": pd_data.get("low"),
                "open": pd_data.get("open"),
                "volume": pd_data.get("volume"),
                "per": pd_data.get("per"),
                "pbr": pd_data.get("pbr"),
                "market_cap_억": pd_data.get("market_cap_억"),
                "foreign_rate": pd_data.get("foreign_rate"),
                "status": s["status"],
            })

        # ---- Step 4: 存入数据库 ----
        save_daily_snapshot(trade_date, dashboard_data)
        save_company_metrics(trade_date, metrics_list)

        # 记录更新日志
        duration = (datetime.now(KST) - start_time).total_seconds()
        with get_db() as conn:
            conn.execute(
                "INSERT INTO update_log (executed_at, target_date, status, companies_updated, duration_seconds) VALUES (?,?,?,?,?)",
                (start_time.isoformat(), trade_date, "success",
                 len(metrics_list), round(duration, 2))
            )
            conn.commit()

        log.info(f"\n{'='*50}")
        log.info(f"✅ 更新完成! {len(metrics_list)}/{len(COMPANIES)} 公司成功 | 耗时 {duration:.1f}s")
        log.info(f"{'='*50}\n")

        dashboard_data["_duration"] = round(duration, 2)
        return dashboard_data

    def _build_per_summary(self, stocks: list) -> Dict:
        """构建 PER 摘要统计"""
        valid_pers = []
        for s in stocks:
            pd = s.get("price_data")
            if pd and pd.get("per") and pd["per"] > 0:
                valid_pers.append({
                    "name": s["name_en"],
                    "per": pd["per"],
                    "close": pd["close"],
                    "color": s["color"],
                })
        
        valid_pers.sort(key=lambda x: x["per"])

        return {
            "all": valid_pers,
            "lowest": valid_pers[0] if valid_pers else None,
            "highest": valid_pers[-1] if valid_pers else None,
            "avg": sum(p["per"] for p in valid_pers) / len(valid_pers) if valid_pers else 0,
            "count": len(valid_pers),
        }


# ============================================================
# Flask API 路由
# ============================================================

@app.route('/')
def index():
    """首页 - 渲染看板主页面"""
    # 获取最新可用日期的快照
    dates = get_available_dates()
    latest_trade_date = dates[0]["trade_date"] if dates else None
    
    snapshot = None
    if latest_trade_date:
        snapshot = get_snapshot_by_date(latest_trade_date)
    
    return render_template(
        'index.html',
        snapshot=snapshot,
        available_dates=dates,
        current_date=latest_trade_date,
    )


@app.route('/api/data/<trade_date>')
def api_get_data(trade_date):
    """API: 获取指定日期的完整数据"""
    snapshot = get_snapshot_by_date(trade_date)
    if snapshot:
        return jsonify({"code": 0, "data": snapshot})
    return jsonify({"code": -1, "msg": f"无 {trade_date} 的数据"}), 404


@app.route('/api/latest')
def api_latest():
    """API: 获取最新数据"""
    dates = get_available_dates()
    if dates:
        snapshot = get_snapshot_by_date(dates[0]["trade_date"])
        if snapshot:
            return jsonify({"code": 0, "date": dates[0]["trade_date"], "data": snapshot})
    return jsonify({"code": -1, "msg": "暂无数据"}), 404


@app.route('/api/dates')
def api_dates():
    """API: 获取所有可用日期列表"""
    dates = get_available_dates()
    return jsonify({"code": 0, "dates": dates})


@app.route('/api/history/<company_code>')
def api_history(company_code):
    """API: 查询公司历史走势"""
    limit = request.args.get('limit', 30, type=int)
    history = get_company_history(company_code, limit)
    return jsonify({"code": 0, "company_code": company_code, "history": history})


@app.route('/api/update', methods=['POST'])
def api_trigger_update():
    """API: 手动触发数据更新"""
    updater = DataUpdater()
    try:
        result = updater.update()
        return jsonify({"code": 0, "msg": "更新成功", "data": result})
    except Exception as e:
        return jsonify({"code": -1, "msg": f"更新失败: {str(e)}"}), 500


@app.route('/static/<path:filename>')
def static_files(filename):
    """静态文件服务"""
    return send_from_directory(app.static_folder, filename)


# ============================================================
# 定时任务调度
# ============================================================

def run_scheduled_update(target_date_str: str = None):
    """执行定时更新任务（供 APScheduler 或外部 cron 调用）"""
    updater = DataUpdater()
    return updater.update(target_date_str)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="韩国游戏股价看板 Web 服务")
    parser.add_argument('--port', type=int, default=5000, help="Web服务端口 (默认5000)")
    parser.add_argument('--host', type=str, default='0.0.0.0', help="监听地址 (默认0.0.0.0)")
    parser.add_argument('--init-db', action='store_true', help="初始化数据库")
    parser.add_argument('--update-now', action='store_true', help="立即执行一次数据更新")
    parser.add_argument('--date', type=str, default=None, help="指定更新日期 (YYYYMMDD)")
    parser.add_argument('--debug', action='store_true', help="调试模式")

    args = parser.parse_args()

    # 初始化数据库
    init_db()

    # 立即更新模式
    if args.update_now:
        updater = DataUpdater()
        result = updater.update(args.date)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # 启动 Web 服务
    log.info(f"""
╔══════════════════════════════════════════════╗
║  🎮 韩国游戏股价看板 - Web服务启动             ║
║                                              ║
║  地址: http://{args.host}:{args.port}
║  数据库: {DB_PATH}
║  定时: 每天上午10:00自动更新                  ║
╚══════════════════════════════════════════════╝
""")

    # 注册定时更新任务 (后台线程)
    from apscheduler.schedulers.background import BackgroundScheduler
    scheduler = BackgroundScheduler(timezone='Asia/Seoul')

    scheduler.add_job(
        run_scheduled_update,
        'cron',
        hour=10,
        minute=0,
        id='daily_stock_update',
        name='每日10:00自动更新韩国游戏股份数据',
        replace_existing=True
    )
    scheduler.start()
    log.info(f"⏰ 定时任务已注册: 每天上午 10:00 自动更新")

    # 启动Flask开发服务器
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
