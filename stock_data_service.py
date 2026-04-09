"""
韩国游戏股价看板 - 数据服务脚本
====================================
参照 stock-monitor/services/stock_service.py + monthly_chart_service.py 机制：
1. pykrx 自动查询韩国实际交易日历（非硬编码周末）
2. 多数据源备用策略：pykrx → FinanceDatareader → Naver（备用）
3. 统一时区：所有日期以韩国时间(KST)为基准
4. 输出JSON供前端 index.html 注入使用

用法:
  python stock_data_service.py              # 默认今日数据
  python stock_data_service.py --date 20260407  # 指定日期
  python stock_data_service.py --month 202604   # 获取月度交易日历+数据
  python stock_data_service.py --check-calendar  # 仅检查交易日历

依赖安装:
  pip install pykrx finance-datareader requests pandas
"""

import argparse
import json
import sys
import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List, Any, Tuple

# ============================================================
# 日志配置
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger(__name__)

# ============================================================
# 常量定义（与 stock-service.py 保持一致）
# ============================================================

# 韩国主要游戏公司 KRX 代码
STOCK_CODES: Dict[str, Dict[str, str]] = {
    "Nexon":        {"code": "042700", "ko_name": "넥슨게임즈", "market": "KOSPI"},
    "NCSoft":       {"code": "036570", "ko_name": "엔씨소프트", "market": "KOSDAQ"},
    "Netmarble":    {"code": "251270", "ko_name": "넷마블",     "market": "KOSDAQ"},
    "Krafton":      {"code": "259960", "ko_name": "크래프톤",   "market": "KOSDAQ"},
    "Pearl Abyss":  {"code": "263750", "ko_name": "펄어비스",   "market": "KOSDAQ"},
    "ShiftUp":      {"code": "391740", "ko_name": "시프트업",   "market": "KOSDAQ"},
    "Com2uS":       {"code": "078340", "ko_name": "컴투스",     "market": "KOSDAQ"},
    "Com2uSHold":   {"code": "900280", "ko_name": "컴투스홀딩스","market": "KOSPI"},
    "Gravity":      {"code": "018670", "ko_name": "그라비티",   "market": "KOSDAQ"},
    "Wemade":       {"code": "112040", "ko_name": "위메이드",   "market": "KOSDAQ"},
}

# 韩国时区 (UTC+9)
KST = timezone(timedelta(hours=9))


# ============================================================
# 数据源抽象层（多数据源备用机制 - 参照 stock_service.py）
# ============================================================

class DataSourceError(Exception):
    """数据源异常基类"""
    pass


class StockDataSource:
    """
    多数据源股价获取引擎
    优先级: pykrx(官方) → financedatareader(社区) → Naver API(备用)
    
    参照 stock_service.py 的 get_stock_data_with_fallback 逻辑
    """

    def __init__(self):
        self._pykrx_available = False
        self._fdr_available = False
        self._check_dependencies()

    def _check_dependencies(self) -> None:
        """检查可用数据源"""
        try:
            import pykrx
            self._pykrx_available = True
            log.info("✅ 数据源1: pykrx 可用")
        except ImportError:
            log.warning("⚠️  数据源1: pykrx 未安装 (pip install pykrx)")

        try:
            import finance_datareader as fdr
            self._fdr_available = True
            log.info("✅ 数据源2: finance-datareader 可用")
        except ImportError:
            log.warning("⚠️  数据源2: finance-datareader 未安装 (pip install finance-datareader)")

    # ---------- 公开接口 ----------

    def get_stock_price(
        self,
        code: str,
        date: str,           # YYYYMMDD
        fallback: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        获取单日股票数据（多数据源自动切换）
        
        返回:
          {
            "open": 开盘价,
            "high": 最高价,
            "low": 最低价,
            "close": 收盘价,
            "volume": 成交量,
            "change": 涨跌额,
            "change_rate": 涨跌幅(%),
            "source": 数据来源名称
          }
          或 None (所有数据源均失败)
        """
        sources = []

        if self._pykrx_available:
            sources.append(("pykrx", self._fetch_pykrx))
        if self._fdr_available:
            sources.append(("finance-datareader", self._fetch_fdr))
        sources.append(("naver-api", self._fetch_naver))

        last_error = None
        for source_name, fetch_func in sources:
            try:
                log.info(f"  📡 尝试 {source_name} 获取 {code} @ {date} ...")
                result = fetch_func(code, date)
                if result is not None:
                    result["source"] = source_name
                    log.info(f"  ✅ {source_name} 成功: ₩{result['close']:,}")
                    return result
            except Exception as e:
                last_error = e
                log.warning(f"  ❌ {source_name} 失败: {e}")
                if not fallback:
                    raise DataSourceError(f"{source_name} 获取失败: {e}")

        log.error(f"  💥 所有数据源均失败: code={code}, date={date}, last_error={last_error}")
        return None

    def get_monthly_data(
        self,
        code: str,
        year: int,
        month: int
    ) -> List[Dict[str, Any]]:
        """
        获取月度每日交易数据（用于折线图）
        只返回有实际交易的日期（休市日自动跳过）
        """
        results = []
        
        if self._pykrx_available:
            try:
                from pykrx import stock
                start_date = f"{year}{month:02d}01"
                # 月末日期简单计算
                if month == 12:
                    end_date = f"{year + 1}0101"
                else:
                    end_date = f"{year}{month + 1:02d}01"
                
                df = stock.get_market_ohlcv_by_date(start_date, end_date, code)
                if df is not None and not df.empty:
                    for date_str, row in df.iterrows():
                        results.append({
                            "date": date_str.strftime("%Y-%m-%d") if hasattr(date_str, 'strftime') else str(date_str),
                            "open": int(row["시가"]),
                            "high": int(row["고가"]),
                            "low": int(row["저가"]),
                            "close": int(row["종가"]),
                            "volume": int(row["거래량"]),
                            "change_rate": round(float(row["등락률"]), 2),
                            "source": "pykrx"
                        })
                    log.info(f"  ✅ pykrx 月度数据: {len(results)} 个交易日")
            except Exception as e:
                log.error(f"❌ pykrx 月度数据获取失败: {e}")
                # fallback 到逐日查询
                results = self._monthly_fallback(code, year, month)
        else:
            results = self._monthly_fallback(code, year, month)

        return results

    def _monthly_fallback(self, code: str, year: int, month: int) -> List[Dict[str, Any]]:
        """月度数据回退方案：逐日查询"""
        import calendar
        _, days_in_month = calendar.monthrange(year, month)
        results = []
        for day in range(1, days_in_month + 1):
            date_str = f"{year}{month:02d}{day:02d}"
            data = self.get_stock_price(code, date_str)
            if data and data.get("close") and data["close"] > 0:
                data["date"] = f"{year}-{month:02d}-{day:02d}"
                results.append(data)
        return results

    # ---------- 具体数据源实现 ----------

    def _fetch_pykrx(self, code: str, date: str) -> Optional[Dict[str, Any]]:
        """数据源1: pykrx 官方库（KRX数据直连）"""
        from pykrx import stock
        
        # 获取当日 OHLCV
        df = stock.get_market_ohlcv_by_date(date, date, code)
        if df is None or df.empty:
            return None
        
        row = df.iloc[0]
        
        # 获取前一收盘价用于计算涨跌额
        # 通过 get_market_ohlcv 获取前一天
        prev_date = self._get_prev_trading_day(date)
        prev_close = 0
        if prev_date:
            try:
                prev_df = stock.get_market_ohlcv_by_date(prev_date, prev_date, code)
                if prev_df is not None and not prev_df.empty:
                    prev_close = int(prev_df.iloc[0]["종가"])
            except Exception:
                pass
        
        close_val = int(row["종가"])
        change = close_val - prev_close if prev_close > 0 else 0
        change_rate = round((change / prev_close * 100) if prev_close > 0 else float(row["등락률"]), 2)

        return {
            "open": int(row["시가"]),
            "high": int(row["고가"]),
            "low": int(row["저가"]),
            "close": close_val,
            "volume": int(row["거래량"]),
            "change": change,
            "change_rate": change_rate,
        }

    def _fetch_fdr(self, code: str, date: str) -> Optional[Dict[str, Any]]:
        """数据源2: finance-datareader (基于Naver数据)"""
        import finance_datareader as fdr
        
        # 转换日期格式
        dt = datetime.strptime(date, "%Y%m%d")
        
        # 需要加上.KS 或 .KQ 后缀
        market_suffix = ".KS"  # 大部分在KOSPI/KOSDAQ都用这个试试
        # 尝试获取
        try:
            df = fdr.stock_detail(f"{code}{market_suffix}", start=date.replace("-", ""))
            if df is not None and not df.empty:
                # 找到目标日期的行
                target_row = None
                for idx, row in df.iterrows():
                    idx_str = str(idx)[:10].replace("-", "")
                    if idx_str == date:
                        target_row = row
                        break
                
                if target_row is not None:
                    return {
                        "open": int(target_row["Open"]) if target_row["Open"] == target_row["Open"] else 0,
                        "high": int(target_row["High"]) if target_row["High"] == target_row["High"] else 0,
                        "low": int(target_row["Low"]) if target_row["Low"] == target_row["Low"] else 0,
                        "close": int(target_row["Close"]) if target_row["Close"] == target_row["Close"] else 0,
                        "volume": int(target_row["Volume"]) if target_row["Volume"] == target_row["Volume"] else 0,
                        "change": int(target_row["Change"]) if target_row["Change"] == target_row["Change"] else 0,
                        "change_rate": round(float(target_row["Change"] / (target_row["Close"] - target_row["Change"]) * 100), 2)
                            if (target_row["Close"] - target_row["Change"]) != 0 and target_row["Change"] == target_row["Change"]
                            else 0,
                    }
        except Exception as e:
            log.debug(f"FDR detail 失败: {e}")
        
        # fallback: 用 stock.get 方法
        try:
            df = fdr.StockListing("KOSDAQ")  # 尝试KOSDAQ
            # 这里只做存在性检查
        except Exception:
            pass
        
        return None

    def _fetch_naver(self, code: str, date: str) -> Optional[Dict[str, Any]]:
        """数据源3: Naver Finance API 直接请求（最终备用）"""
        import requests
        
        # Naver Finance JSONP 接口
        url = (
            f"https://api.finance.naver.com/siseJson.naver?"
            f"symbol={code}&requestType=1"
            f"&startTime={date}&endTime={date}&timeframe=day"
        )
        
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": f"https://finance.naver.com/item/main.naver?code={code}",
        }
        
        try:
            resp = requests.get(url, headers=headers, timeout=10)
            resp.encoding = "euc-kr"
            data = resp.text
            
            # 解析返回的数据（Naver 返回逗号分隔格式）
            if data.strip() and len(data.strip()) > 10:
                lines = data.strip().split("\n")
                if len(lines) >= 2:
                    parts = lines[1].split(",")
                    if len(parts) >= 8:
                        # Naver 格式: 日期,开盘,最高,最低,收盘,成交量,...
                        return {
                            "open": int(float(parts[1])),
                            "high": int(float(parts[2])),
                            "low": int(float(parts[3])),
                            "close": int(float(parts[4])),
                            "volume": int(float(parts[5])),
                            "change": int(float(parts[4]) - float(parts[6])) if len(parts) > 6 else 0,
                            "change_rate": 0,  # 需要前日收盘价计算
                        }
        except Exception as e:
            log.debug(f"Naver API 错误: {e}")
        
        return None

    @staticmethod
    def _get_prev_trading_day(date_str: str) -> Optional[str]:
        """获取前一个交易日（简单回溯，最多往前查5天）"""
        dt = datetime.strptime(date_str, "%Y%m%d")
        for i in range(1, 6):
            prev = dt - timedelta(days=i)
            # 简单排除周末（精确判断应通过 pykrx）
            if prev.weekday() < 5:
                return prev.strftime("%Y%m%d")
        return None


# ============================================================
# 交易日历服务（参照 monthly_chart_service.py）
# ============================================================

class TradingCalendarService:
    """
    韩国交易日历查询服务
    
    核心能力（参照 monthly_chart_service.py 的休市日检测）：
    1. 使用 pykrx 从 KRX 查询实际交易日历
    2. 区分周末、法定节假日、临时休市
    3. 提供给前端判断某日是否有交易数据
    """

    def __init__(self, datasource: StockDataSource):
        self.ds = datasource
        self._cache: Dict[str, List[str]] = {}  # year-month → [trading_days]

    def get_trading_days(self, year: int, month: int) -> List[str]:
        """
        获取指定月份的所有交易日列表
        
        返回: ["2026-04-01", "2026-04-02", ...] 格式日期列表
               仅包含实际有交易的日期
        """
        cache_key = f"{year}-{month:02d}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        trading_days = []

        if self.ds._pykrx_available:
            trading_days = self._from_pykrx(year, month)
        else:
            trading_days = self._fallback_estimate(year, month)

        self._cache[cache_key] = trading_days
        return trading_days

    def is_trading_day(self, date_str: str) -> bool:
        """判断给定日期是否为交易日"""
        try:
            if len(date_str) == 8:
                dt = datetime.strptime(date_str, "%Y%m%d")
            elif "-" in date_str:
                dt = datetime.strptime(date_str, "%Y-%m-%d")
            else:
                return False
            
            year, month = dt.year, dt.month
            trading_days = self.get_trading_days(year, month)
            
            # 标准化日期格式比较
            target = f"{year}-{month:02d}-{dt.day:02d}"
            return target in trading_days
        except Exception:
            return False

    def get_latest_trading_day(self, ref_date: Optional[datetime] = None) -> Optional[str]:
        """
        获取参考日期之前的最近一个交易日
        
        用于"最新收盘数据"场景
        """
        if ref_date is None:
            ref_date = datetime.now(KST)
        
        # 往前查找最多5天
        for i in range(6):
            check_date = ref_date - timedelta(days=i)
            date_str = check_date.strftime("%Y-%m-%d")
            if self.is_trading_day(date_str):
                return date_str
        
        return None

    def get_next_trading_day(self, ref_date: Optional[datetime] = None) -> Optional[str]:
        """获取参考日期之后的最近一个交易日"""
        if ref_date is None:
            ref_date = datetime.now(KST)
        
        for i in range(6):
            check_date = ref_date + timedelta(days=i)
            date_str = check_date.strftime("%Y-%m-%d")
            if self.is_trading_day(date_str):
                return date_str
        
        return None

    def _from_pykrx(self, year: int, month: int) -> List[str]:
        """从 pykrx 获取实际交易日历"""
        try:
            from pykrx import stock
            
            start = f"{year}{month:02d}01"
            if month >= 12:
                end = f"{year + 1}0101"
            else:
                end = f"{year}{month + 1:02d}01"

            # 使用任意大盘代码获取交易日历（KOSPI指数）
            df = stock.get_market_ohlcv_by_date(start, end, "001001")  # KOSPI指数
            
            if df is not None and not df.empty:
                days = []
                for date_idx in df.index:
                    if hasattr(date_idx, 'strftime'):
                        days.append(date_idx.strftime("%Y-%m-%d"))
                    else:
                        # 处理字符串索引
                        s = str(date_idx).replace("-", "")[:8]
                        days.append(f"{s[:4]}-{s[4:6]}-{s[6:8]}")
                log.info(f"📅 pykrx 交易日历 {year}-{month:02d}: {len(days)} 个交易日")
                return days
        except Exception as e:
            log.error(f"❌ pykrx 交易日历获取失败: {e}")

        return []

    def _fallback_estimate(self, year: int, month: int) -> List[str]:
        """
        回退方案：简单排除周末
        （不精确，因为不含韩国法定节假日如国庆节/选举日等）
        """
        import calendar
        _, days_in_month = calendar.monthrange(year, month)
        days = []
        for d in range(1, days_in_month + 1):
            dt = datetime(year, month, d)
            if dt.weekday() < 5:  # 周一到周五
                days.append(f"{year}-{month:02d}-{d:02d}")
        
        log.warning(f"⚠️ 使用简单周末排除估算交易日历 {year}-{month:02d}: {len(days)} 天 (可能含节假日)")
        return days

    def print_calendar(self, year: int, month: int) -> None:
        """打印可视化的交易日历"""
        trading_days = set(self.get_trading_days(year, month))
        import calendar
        
        cal = calendar.Calendar()
        print(f"\n{'='*40}")
        print(f"  🇰🇷 韩国证券交易所交易日历 - {year}年{month}月")
        print(f"{'='*40}")
        print(f"  一  二  三  四  五  六  日")
        print(f"  {'--'*7}")
        
        for week in cal.monthdayscalendar(year, month):
            row = ""
            for day in week:
                if day == 0:
                    row += "    "
                else:
                    date_key = f"{year}-{month:02d}-{day:02d}"
                    if date_key in trading_days:
                        row += f" {day:2d} "
                    else:
                        row += f" ·  "
            print(row)
        
        total = len(trading_days)
        print(f"\n  📊 该月共 {total} 个交易日")
        non_trading = sum(1 for w in cal.monthdayscalendar(year, month) for d in w if d != 0 
                         and f"{year}-{month:02d}-{d:02d}" not in trading_days)
        print(f"  📌 休市/非交易日: {non_trading} 天 (含周末+法定节假日)")
        print(f"{'='*40}\n")


# ============================================================
# 主业务逻辑
# ============================================================

class StockDashboardService:
    """
    看板数据聚合服务
    整合交易日历 + 多数据源股价查询 → 输出标准JSON
    """

    def __init__(self):
        self.ds = StockDataSource()
        self.calendar = TradingCalendarService(self.ds)

    def generate_dashboard_data(
        self,
        target_date: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        生成看板完整数据包
        
        参数:
          target_date: 目标日期 YYYYMMDD，默认=最近交易日
        
        返回:
          {
            "meta": {...},
            "stocks": [{公司数据...}],
            "calendar": {交易日历信息},
            "data_source": {各公司数据来源}
          }
        """
        # 确定目标日期
        if target_date:
            target_dt = datetime.strptime(target_date, "%Y%m%d")
        else:
            latest = self.calendar.get_latest_trading_day()
            if latest:
                target_dt = datetime.strptime(latest, "%Y-%m-%d")
            else:
                target_dt = datetime.now(KST)
        
        date_str = target_dt.strftime("%Y%m%d")
        date_display = target_dt.strftime("%Y年%-m月%-d日")
        
        # 判断是否为交易日
        is_trading = self.calendar.is_trading_day(date_str)
        
        # 星期映射
        weekdays_kr = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        weekday_str = weekdays_kr[target_dt.weekday()]

        # 获取月度交易日历
        month_cal = self.calendar.get_trading_days(target_dt.year, target_dt.month)

        result = {
            "meta": {
                "target_date": date_str,
                "display_date": date_display,
                "weekday": weekday_str,
                "is_trading_day": is_trading,
                "year": target_dt.year,
                "month": target_dt.month,
                "generated_at": datetime.now(KST).isoformat(),
                "kst_timezone": "+09:00",
            },
            "calendar": {
                "trading_days": month_cal,
                "total_trading_days": len(month_cal),
                "method": "pykrx" if self.ds._pykrx_available else "estimate",
            },
            "stocks": [],
            "data_source_summary": {},
        }

        # 逐公司查询股价
        log.info(f"\n{'='*50}")
        log.info(f"📊 查询日期: {date_display} ({weekday_str}) | 交易日: {'是' if is_trading else '否 - 将用最近交易日'}")
        log.info(f"{'='*50}\n")

        for company_name, info in STOCK_CODES.items():
            code = info["code"]
            ko_name = info["ko_name"]

            log.info(f"🔍 {company_name} ({ko_name}) [{code}]")

            # 如果目标日期不是交易日，自动找最近交易日
            query_date = date_str
            if not is_trading:
                latest_td = self.calendar.get_latest_trading_day(target_dt)
                if latest_td:
                    query_date = latest_td.replace("-", "")
                    log.info(f"  → 目标非交易日用最近交易日: {query_date}")

            price_data = self.ds.get_stock_price(code, query_date)

            entry = {
                "name_en": company_name,
                "name_ko": ko_name,
                "code": code,
                "market": info["market"],
                "price_data": price_data,
                "status": "ok" if price_data else "no_data",
            }

            result["stocks"].append(entry)

            # 记录数据来源统计
            if price_data:
                src = price_data.get("source", "unknown")
                result["data_source_summary"][src] = \
                    result["data_source_summary"].get(src, 0) + 1

        # 输出摘要
        ok_count = sum(1 for s in result["stocks"] if s["status"] == "ok")
        log.info(f"\n{'='*50}")
        log.info(f"✅ 完成: {ok_count}/{len(result['stocks']} 公司数据获取成功")
        log.info(f"📡 数据源分布: {result['data_source_summary']}")
        log.info(f"📅 交易日历: {result['calendar']['total_trading_days']} 个交易日 (方式: {result['calendar']['method']})")
        log.info(f"{'='*50}\n")

        return result

    def generate_chart_data(
        self,
        year: int,
        month: int,
        companies: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        生成图表用的月度数据（用于对比折线图）
        
        参照 monthly_chart_service.py 的 get_monthly_chart_data
        """
        if companies is None:
            companies = list(STOCK_CODES.keys())

        chart_result = {
            "year": year,
            "month": month,
            "companies": {},
            "trading_days": self.calendar.get_trading_days(year, month),
        }

        for company in companies:
            if company not in STOCK_CODES:
                continue
            code = STOCK_CODES[company]["code"]
            monthly_data = self.ds.get_monthly_data(code, year, month)
            chart_result["companies"][company] = {
                "code": code,
                "daily_data": monthly_data,
                "days_count": len(monthly_data),
            }

        return chart_result


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="韩国游戏股价看板数据服务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s                              # 今日数据
  %(prog)s --date 20260407             # 指定日期
  %(prog)s --month 202604              # 月度图表数据
  %(prog)s --check-calendar            # 打印交易日历
  %(prog)s --output json               # 输出为JSON文件
        """
    )

    parser.add_argument(
        "--date", "-d",
        type=str,
        default=None,
        help="目标日期 (YYYYMMDD)，默认=最近交易日"
    )
    parser.add_argument(
        "--month", "-m",
        type=str,
        default=None,
        help="获取月度数据 (YYYYMM)"
    )
    parser.add_argument(
        "--check-calendar", "-c",
        action="store_true",
        help="打印当月交易日历并退出"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        choices=["json", "pretty"],
        default="pretty",
        help="输出格式 (默认: pretty)"
    )
    parser.add_argument(
        "--outfile",
        type=str,
        default=None,
        help="输出到文件路径 (仅json模式有效)"
    )

    args = parser.parse_args()

    # 初始化服务
    service = StockDashboardService()

    # 模式1: 仅查看交易日历
    if args.check_calendar:
        now = datetime.now(KST)
        y, m = now.year, now.month
        if args.month:
            y = int(args.month[:4])
            m = int(args.month[4:])
        service.calendar.print_calendar(y, m)
        return

    # 模式2: 月度图表数据
    if args.month:
        y = int(args.month[:4])
        m = int(args.month[4:6])
        chart_data = service.generate_chart_data(y, m)
        
        # 同时打印交易日历
        service.calendar.print_calendar(y, m)
        
        if args.output == "json":
            output = json.dumps(chart_data, ensure_ascii=False, indent=2)
            if args.outfile:
                with open(args.outfile, "w", encoding="utf-8") as f:
                    f.write(output)
                log.info(f"💾 月度数据已保存至: {args.outfile}")
            else:
                print(output)
        else:
            print("\n📈 月度图表数据预览:")
            for company, data in chart_data["companies"].items():
                print(f"  {company}: {data['days_count']} 个交易日")
        return

    # 模式3: 单日看板数据（默认模式）
    dashboard_data = service.generate_dashboard_data(args.date)

    if args.output == "json":
        output = json.dumps(dashboard_data, ensure_ascii=False, indent=2)
        if args.outfile:
            with open(args.outfile, "w", encoding="utf-8") as f:
                f.write(output)
            log.info(f"💾 数据已保存至: {args.outfile}")
        else:
            print(output)
    else:
        # Pretty print 摘要
        print_pretty(dashboard_data)


def print_pretty(data: Dict[str, Any]) -> None:
    """美化输出结果"""
    meta = data["meta"]
    
    print("\n" + "=" * 60)
    print(f"  🎮 韩国游戏公司股价数据")
    print(f"  📅 {meta['display_date']} ({meta['weekday']}) | 交易日: {'✅' if meta['is_trading_day'] else '❌'}")
    print("=" * 60)

    print(f"\n  📊 交易日历 ({meta['year']}年{meta['month']}月): "
          f"{data['calendar']['total_trading_days']} 个交易日 "
          f"[{data['calendar']['method']}]")

    print(f"\n  {'─'*56}")
    print(f"  {'公司':<14} {'代码':<8} {'收盘价':>10} {'涨跌幅':>8} {'状态':>6} {'来源'}")
    print(f"  {'─'*56}")

    for stock in data["stocks"]:
        name = stock["name_en"]
        code = stock["code"]
        
        pd = stock.get("price_data")
        if pd:
            close = pd.get("close", 0)
            rate = pd.get("change_rate", 0)
            src = pd.get("source", "-")
            
            rate_str = f"+{rate:.2f}%" if rate > 0 else f"{rate:.2f}%"
            status = "✅"
            
            print(f"  {name:<13} {code:<8} ₩{close:>9,} {rate_str:>8} {status:>6} {src}")
        else:
            print(f"  {name:<13} {code:<8} {'-':>10} {'-':>8} {'❌':>6} 无数据")

    print(f"  {'─'*56}")
    
    # 数据源汇总
    ds_summary = data.get("data_source_summary", {})
    if ds_summary:
        print(f"\n  📡 数据源: {', '.join(f'{k}({v})' for k,v in ds_summary.items())}")
    
    print()


if __name__ == "__main__":
    main()
