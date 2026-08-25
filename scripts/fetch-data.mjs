#!/usr/bin/env node
/**
 * 数据抓取脚本 v3 — 多源容错策略
 * 
 * 数据来源 (按优先级):
 *   1. Naver K线图 JSON API (fchart.stock.naver.com) - 历史价格
 *   2. Naver 主页面 HTML (带完整浏览器headers) - 实时数据
 *   3. Yahoo Finance API (备用) - 全球股票数据
 * 
 * 输出: data/YYYYMMDD.json (每日快照)
 *       data/latest.json  (最新数据)
 *       data/dates.json   (可用日期列表)
 * 
 * 用法: node scripts/fetch-data.mjs
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// ============================================================
// 大盘指数配置 (KOSPI & KOSDAQ)
// ============================================================
const INDICES = [
  { code: 'KOSPI',   name: 'KOSPI',   yahoo: '^KS11' },
  { code: 'KOSDAQ',  name: 'KOSDAQ',  yahoo: '^KQ11' },
];

// ============================================================
// 公司配置
// ============================================================
const COMPANIES = [
  { code: '462870', name: 'Shift Up',       color: '#ff6b9d', yahoo: '462870.KQ' },
  { code: '225570', name: 'Nexon Games',    color: '#22c55e', yahoo: '225570.KS' },
  { code: '251270', name: 'Netmarble',      color: '#ef4444', yahoo: '251270.KS' },
  { code: '036570', name: 'NC',            color: '#3b82f6', yahoo: '036570.KS' },
  { code: '259960', name: 'Krafton',        color: '#f59e0b', yahoo: '259960.KQ' },
  { code: '263750', name: 'Pearl Abyss',    color: '#ec4899', yahoo: '263750.KS' },
];

// ============================================================
// KRX 休市日（2026年）
// ============================================================
const KRX_HOLIDAYS = [
  '20260101', '20260216', '20260217', '20260218',
  '20260302', '20260501', '20260505', '20260525',
  '20260603', '20260717', '20260817',
  '20260924', '20260925', '20261005',
  '20261009', '20261225', '20261231'
];

// ============================================================
// 工具函数
// ============================================================
function getLatestTradingDay() {
  const now = new Date();
  // 精确转换为韩国时间（UTC+9），避免 koreaHour 溢出 24 的 bug
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  
  let targetYear  = kstTime.getUTCFullYear();
  let targetMonth = kstTime.getUTCMonth();
  let targetDay   = kstTime.getUTCDate();
  const kstHour   = kstTime.getUTCHours();
  const kstMin    = kstTime.getUTCMinutes();
  
  // 韩国股市收盘时间 15:30 KST
  // 如果还没到收盘，取前一个交易日（看板显示昨收数据）
  if (kstHour < 15 || (kstHour === 15 && kstMin < 30)) {
    targetDay -= 1; // Date.UTC 会自动处理跨月/跨年
  }
  
  const d = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  
  // 回退非交易日（周末 + KRX 休市日）
  while (true) {
    const day = d.getUTCDay();
    if (day === 0) { d.setUTCDate(d.getUTCDate() - 2); continue; }  // 周日 -> 周五
    if (day === 6) { d.setUTCDate(d.getUTCDate() - 1); continue; }  // 周六 -> 周五
    const dateStr = formatDate(d);
    if (KRX_HOLIDAYS.includes(dateStr)) { d.setUTCDate(d.getUTCDate() - 1); continue; }
    break;
  }
  
  return d;
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatPrice(p) {
  if (!p && p !== 0) return '-';
  return Math.round(Number(p)).toLocaleString('en-US');
}

function formatWon(n) {
  if (!n || isNaN(n)) return '-';
  const num = Number(n);
  if (num >= 1000000000000) return `${(num / 1000000000000).toFixed(2)}兆元`;
  if (num >= 100000000) return `${(num / 100000000).toFixed(2)}亿元`;
  if (num >= 10000) return `${Math.round(num / 10000).toLocaleString()}亿 ₩`;
  return `≈ ${Math.round(num).toLocaleString()}₩`;
}


function changeClass(change) {
  const c = parseFloat(change);
  if (c > 0) return 'up';
  if (c < 0) return 'down';
  return 'neutral';
}

// ============================================================
// 大盘指数抓取 (KOSPI / KOSDAQ)
// ============================================================

async function fetchIndexData(index, targetDateStr) {
  // 主数据源: Naver K线图 API（与个股一致，能正确锁定"已完结交易日"收盘价）
  // 注意：Naver 的 siseJson 接口对 KOSPI/KOSDAQ 指数同样有效（symbol=KOSPI/KOSDAQ）
  // 修复根因：旧实现用 Yahoo 实时 chart 的 closes[length-1] 作为"当前价"，
  // 若工作流在交易时段内运行，取到的是"今天盘中实时价"而非"目标交易日收盘价"，
  // 导致 meta.date 标注的日期与指数实际涨跌幅错配（例如把7/29盘中数据误标为7/28）。
  console.log(`  📈 [Index] Fetching: ${index.name}`);
  try {
    const chartData = await fetchNaverChart(index.code, targetDateStr);
    if (chartData && chartData.price) {
      const changePercent = chartData.changePercent ?? '0.00';
      console.log(`  ✅ [Index-Naver] ${index.name}: ${chartData.price} (${chartData.change >= 0 ? '+' : ''}${changePercent}%) [${chartData.date}]`);
      return {
        code: index.code,
        name: index.name,
        price: Number(chartData.price).toFixed(2),
        change: Number(chartData.change).toFixed(2),
        changePercent: changePercent,
        changeClass: changeClass(chartData.change),
      };
    }
    throw new Error('Naver chart data unavailable');
  } catch (naverErr) {
    console.warn(`  ⚠️ [Index] Naver数据源失败 (${naverErr.message})，回退到 Yahoo Finance`);
  }

  // 备用数据源: Yahoo Finance（存在盘中数据错配风险，仅作最终降级方案）
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${index.yahoo}?interval=1d&range=5d`;

    const resp = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://finance.yahoo.com/' },
    });

    const json = await resp.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('No index data');

    const closes = result.indicators?.quote?.[0]?.close || [];
    if (closes.length < 2) throw new Error('Insufficient data');

    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const change = currentPrice - prevPrice;
    const changePercent = prevPrice > 0 ? ((change / prevPrice) * 100).toFixed(2) : '0.00';

    // 可信度校验：2026-08-24 曾出现 Naver 指数接口同时失效兜底到 Yahoo 的情况，
    // Yahoo 对 KOSPI/KOSDAQ 也返回过明显失真的涨跌幅（如两指数几乎相同的-2%），
    // 大盘指数历史上单日波动极少超过±10%，超过即判定为不可信兜底数据并丢弃。
    if (Math.abs(parseFloat(changePercent)) > 10) {
      console.error(`  ❌ [Sanity] ${index.name}: Yahoo兜底涨跌幅 ${changePercent}% 超过可信阈值(±10%)，判定为脏数据并丢弃`);
      return null;
    }

    console.log(`  ✅ [Index-Yahoo-fallback] ${index.name}: ${currentPrice.toFixed(2)} (${change >= 0 ? '+' : ''}${changePercent}%)`);

    return {
      code: index.code,
      name: index.name,
      price: currentPrice.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent,
      changeClass: changeClass(change),
    };
  } catch (err) {
    console.error(`  ❌ [Index] Failed for ${index.name}: ${err.message}`);
    return null;
  }
}

async function fetchAllIndices(targetDateStr) {
  console.log('\n📊 正在抓取大盘指数...\n');
  const results = await Promise.all(INDICES.map(idx => fetchIndexData(idx, targetDateStr)));
  return results.filter(r => r !== null);
}

/**
 * 通用 fetch 封装，带重试和完整浏览器 headers
 */
async function fetchWithRetry(url, options = {}, retries = 3) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    ...options.headers,
  };

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, headers: defaultHeaders });
      if (resp.ok) return resp;
      
      // 如果不是 429/503，不要重试
      if (resp.status !== 429 && resp.status !== 503 && resp.status !== 502) {
        throw new Error(`HTTP ${resp.status}`);
      }
      
      // 指数退避等待
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// ============================================================
// 数据源1: Naver K线图 JSON API
// URL: https://fchart.stock.naver.com/siseJson.naver?symbol=CODE&timeframe=day&count=15&requestType=0
// requestType=0 返回完整历史数据 (requestType=1 在新规则下只返回表头)
// 返回: [[日期, 开盘, 高, 低, 收盘, 成交量, 外国人持股率], ...]
// ============================================================

async function fetchNaverChart(code, targetDateStr) {
  try {
    // requestType=0 + count=80 拿最近80天数据（含今天）
    // 需要覆盖至少2个月的完整交易日（约40-45个交易日）
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=80&requestType=0`;
    console.log(`  📊 [NaverChart] Fetching: ${code} (requestType=0, count=45)`);
    
    const resp = await fetchWithRetry(url);
    const buf = await resp.arrayBuffer();
    
    // Naver K线 API 返回 UTF-8 编码 + 单引号格式（验证于 2026.04.09）
    // 原始格式: [['날짜', '시가', ...], ["20260408", 33400, ...], ...]
    // 需要将单引号替换为双引号后才能 JSON.parse
    let text = new TextDecoder('utf-8').decode(buf);
    
    // 清理前后空白
    text = text.trim();
    
    // 找到第一个 '[' 开始的位置（跳过可能的 BOM 或前导字符）
    const startIdx = text.indexOf('[');
    if (startIdx > 0) text = text.substring(startIdx);

    // 单引号 → 双引号（Naver API 返回的是单引号格式，不是标准 JSON）
    text = text.replace(/'/g, '"');

    // 解析 JSON
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) throw new Error('No data');

    // 第一行是表头 ["날짜", "시가", ...]，后续是数据行
    const allData = [];
    for (const item of data) {
      if (Array.isArray(item) && item.length >= 5 && /^\d{8}$/.test(String(item[0]))) {
        allData.push({
          date: String(item[0]),
          open: parseInt(item[1]),
          high: parseInt(item[2]),
          low: parseInt(item[3]),
          close: parseInt(item[4]),
          volume: parseInt(item[5]) || 0,
          foreignRate: parseFloat(item[6]) || 0,
        });
      }
    }

    if (allData.length === 0) throw new Error('No data rows after parse');
    
    const lastEntry = allData[allData.length - 1];
    const secondLast = allData[allData.length - 2];
    const thirdLast = allData.length > 2 ? allData[allData.length - 3] : secondLast;
    
    // 如果最后一条数据的日期匹配目标交易日，使用最新数据
    // 否则（盘中可能不完整）回退到倒数第2条
    let targetPrice, prevPrice, dataDate;
    if (targetDateStr && lastEntry.date === targetDateStr) {
      // 目标交易日数据已完整（收盘后/非交易日运行）
      targetPrice = lastEntry.close;
      prevPrice = secondLast.close;
      dataDate = lastEntry;
    } else {
      // 盘中运行，最后一条可能不完整，取倒数第2条
      targetPrice = secondLast.close;
      prevPrice = thirdLast.close;
      dataDate = secondLast;
    }

    console.log(`  ✅ [NaverChart] ${code}: 收盘(${dataDate.date})=${targetPrice.toLocaleString()}, change=${targetPrice - prevPrice}`);
    
    return {
      price: targetPrice,                    // 最新收盘价
      date: dataDate.date,                   // 数据日期
      open: dataDate.open,
      high: dataDate.high,
      low: dataDate.low,
      yesterdayClose: prevPrice,             // 前日收盘（用于算变化）
      change: targetPrice - prevPrice,       // 较前日涨跌额
      changePercent: prevPrice > 0 ? (((targetPrice - prevPrice) / prevPrice) * 100).toFixed(2) : null,
      volume: dataDate.volume,
      _source: 'naver_chart_api_v2',
      _allHistory: allData,                  // 走势图 + compareChart 用（全量保留）
      _todayData: lastEntry,                 // 今日数据备用
    };
  } catch (err) {
    console.error(`  ❌ [NaverChart] Failed for ${code}: ${err.message}`);
    return null;
  }
}


// ============================================================
// 数据源2: Naver 主页面 HTML 解析 (获取 PER/PBR 等估值指标)
// 使用更完整的浏览器模拟
// ============================================================

async function fetchNaverHtml(code) {
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${code}`;
    console.log(`  🌐 [NaverHTML] Fetching main page: ${code}`);

    const resp = await fetchWithRetry(url, {
      headers: {
        'Referer': 'https://finance.naver.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    // Naver 实际返回 UTF-8 编码（验证于 2026.04.09）
    const buf = await resp.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(buf);
    const result = {};

    // ---- 方法1: 实时价格 — blind span 内 (用于反算前收盘) ----
    // <span class="blind">33,200</span> 在 no_today > em 内部
    let m = html.match(/class="no_today"[\s\S]*?<span class="blind">([,\d]+)<\/span>/s);
    if (m) {
      result.currentPrice = parseInt(m[1].replace(/,/g, ''));
      console.log(`  ✅ [NaverHTML-blind] currentPrice=${result.currentPrice}`);
    }

    // ---- 方法2: 涨跌额 + 涨跌幅% (no_exday 区域的 blind span) ----
    m = html.match(/class="no_exday"[\s\S]*?<span class="blind">([-\d,]+)<\/span>/s);
    if (m) {
      result.change = parseInt(m[1].replace(/,/g, ''));
    }
    m = html.match(/class="no_exday"[\s\S]*?<span class="blind">([-\d,]+)<\/span>[\s\S]*?<span class="blind">([-\d.]+)<\/span>/s);
    if (m) {
      result.change = parseInt(m[1].replace(/,/g, ''));
      result.changePercent = m[2];
    }
    
    // ---- 核心逻辑：price = 前一日收盘价（非实时价格）----
    // 看板显示的是前收盘价，通过 实时价 - 涨跌额 反算
    if (result.currentPrice && result.change) {
      result.price = result.currentPrice - result.change;  // 前收盘 = 当前 - 涨跌
      result.yesterdayClose = result.price;                 // 昨收就是 price 本身
      console.log(`  ✅ [NaverHTML] price(前收盘)=${result.price}, currentPrice=${result.currentPrice}, change=${result.change} (${result.changePercent || '-'}%)`);
    } else if (result.currentPrice) {
      // 没有涨跌数据时，用实时价格作为 fallback（交易中可能还没更新涨跌）
      result.price = result.currentPrice;
      console.log(`  ⚠️ [NaverHTML] 无涨跌数据，使用当前价=${result.price}`);
    }

    // ---- 方法3: PER — 使用 PER(%) 同业对比表格（右侧 종합정보 显示的值）----
    // Naver Finance 有两个 PER 表格：
    //   表1: <strong>PER(배)</strong> → 多期历史数据，列含义复杂不准确
    //   表2: <span>PER(%)</span> → **同行对比PER**，这是右侧栏显示的正确值！
    // 策略：优先用表2 PER(%)，回退到表1
    let perFound = false;

    // 策略1：PER(%) 同业对比表格（最准确，与右侧栏一致）
    const perPercentMatch = html.match(/<span>PER\(%\)<\/span><\/th>\s*<td>([\d.\-&;]+)<\/td>/);
    if (perPercentMatch) {
      let val = perPercentMatch[1].replace(/&nbsp;/g, '').trim();
      if (val && val !== '-') {
        const num = parseFloat(val);
        // 负数或极大负数 → N/A（EPS为负时Naver显示无意义的大负数如-420.61）
        if (num < 0 || isNaN(num)) {
          result.per = null;
          console.log(`  ✅ [NaverHTML-PER(%)] per=N/A (val=${val}, EPS likely negative)`);
        } else {
          result.per = val;
          console.log(`  ✅ [NaverHTML-PER(%)] per=${result.per} (同业对比表格)`);
        }
        perFound = true;
      }
    }

    // 策略2：如果 PER(%) 未匹配到，尝试从摘要区获取 "XX.XX배"
    if (!perFound) {
      const summaryPer = html.match(/(\d+\.\d{2})배\s*l\s*/);
      if (summaryPer) {
        result.per = summaryPer[1];
        console.log(`  ✅ [NaverHTML-PER-摘要] per=${result.per}`);
        perFound = true;
      }
    }

    // 策略3：最终回退到 PER(배) 表格的 cell_strong
    if (!perFound) {
      const perMatch = html.match(/<strong>PER/);
      if (perMatch) {
        const perArea = html.substring(perMatch.index, perMatch.index + 1000);
        let strongMatch = perArea.match(/class="[^"]*cell_strong[^"]*"[^>]*>\s*([\d.\-]+|&nbsp;)\s*</);
        if (strongMatch) {
          const val = strongMatch[1];
          if (val !== '&nbsp;' && val !== '-' && val !== '') {
            result.per = val;
            console.log(`  ⚠️ [NaverHTML-PER(배)-fallback] per=${result.per} (cell_strong)`);
          } else {
            result.per = null;
            console.log(`  ⚠️ [NaverHTML-PER(배)] per=N/A`);
          }
        }
      }
    }

    // ---- 方法4: PBR — 摘要区 "XX.XX배" 格式（与右侧栏一致）----
    // PBR 没有 PBR(%) 对比表格，但摘要区有 "X.XX배 | XX,XXX원" 的格式
    let pbrFound = false;
    
    // 策略1：摘要区的 PBR "<em id="_pbr">X.XX</em>배" 格式
    const summaryPbr = html.match(/id="_pbr">\s*([\d.\-]+)\s*</);
    if (summaryPbr) {
      result.pbr = summaryPbr[1];
      console.log(`  ✅ [NaverHTML-PBR-摘要] pbr=${result.pbr}`);
      pbrFound = true;
    }

    // 策略2：回退到 PBR(배) 表格
    if (!pbrFound) {
      const pbrMatch = html.match(/<strong>PBR/);
      if (pbrMatch) {
        const pbrArea = html.substring(pbrMatch.index, pbrMatch.index + 800);
        
        // 优先找 cell_strong 列
        let strongMatch = pbrArea.match(/class="[^"]*cell_strong[^"]*"[^>]*>\s*([\d.\-]+|&nbsp;)\s*/);
        if (strongMatch) {
          const val = strongMatch[1];
          if (val !== '&nbsp;' && val !== '-' && val !== '') {
            result.pbr = val;
            console.log(`  ⚠️ [NaverHTML-PBR(배)-fallback] pbr=${result.pbr} (cell_strong)`);
          } else {
            result.pbr = null;
            console.log(`  ⚠️ [NaverHTML-PBR(배)] PBR=N/A`);
          }
        } else {
          // 取最后一列
          const allPbrValues = [...pbrArea.matchAll(/<td[^>]*>\s*([\d.]+|-|&nbsp;)\s*<\/td>/g)]
            .map(m => m[1])
            .filter(v => v !== '-' && v !== '&nbsp;' && v !== '');
          if (allPbrValues.length > 0) {
            result.pbr = allPbrValues[allPbrValues.length - 1];
            console.log(`  ✅ [NaverHTML-PBR(배)] pbr=${result.pbr} (fallback last col)`);
          }
        }
      }
    }

    // ---- 方法5: 市值 시가총액(억) ----
    // HTML 结构: <th>시가총액(억)</th>...<td>19,582</td>
    // 注意: 这是"比较表格"，第一个 td 是目标公司，后面是同行对比
    const capMatch = html.match(/시가총액\(억\)[\s\S]*?<\/th>\s*<td[^>]*>\s*([\d,]+)\s*<\/td>/s);
    if (capMatch) {
      // 单位是 억원（亿韩元），转为 원（乘1亿）
      result.marketCap = parseInt(capMatch[1].replace(/,/g, '')) * 100000000;
      console.log(`  ✅ [NaverHTML-MarketCap] marketCap=${result.marketCap} (${parseInt(capMatch[1].replace(/,/,''))}억원)`);
    }

    // ---- 方法6: 流通股数 상장주식수 ----
    const shareMatch = html.match(/상장주식수[\s\S]*?<\/th>\s*<td[^>]*>\s*<em>([\d,]+)<\/em>\s*<\/td>/s);
    if (shareMatch) {
      result.sharesOutstanding = parseInt(shareMatch[1].replace(/,/g, ''));
      console.log(`  ✅ [NaverHTML-Shares] shares=${result.sharesOutstanding.toLocaleString()}`);
    }

    if (result.price) {
      result._source = 'naver_html_euckr';
      console.log(`  ✅ [NaverHTML] ${code}: price=${result.price}, PER=${result.per || '-'}, PBR=${result.pbr || '-'}, change=${result.change || '-'}`);
      return result;
    }
    
    throw new Error('Could not extract price from HTML');
  } catch (err) {
    console.error(`  ❌ [NaverHTML] Failed for ${code}: ${err.message}`);
    return null;
  }
}


// ============================================================
// 数据源3: Yahoo Finance API (备用方案)
// 注意: Yahoo 对韩国股票的支持有限，KOSDAQ 股票可能不可用
// ============================================================

async function fetchYahooFinance(yahooSymbol, code) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`;
    console.log(`  📈 [YahooFinance] Fetching: ${yahooSymbol} (${code})`);
    
    const resp = await fetchWithRetry(url, {
      headers: {
        'Referer': 'https://finance.yahoo.com/',
      },
    });
    
    const json = await resp.json();
    const quote = json?.chart?.result?.[0]?.meta;
    if (!quote) throw new Error('No quote data');
    
    console.log(`  ✅ [YahooFinance] ${code}: close=${quote.regularMarketPrice}, prev=${quote.chartPreviousClose}`);
    
    return {
      price: quote.regularMarketPrice,
      yesterdayClose: quote.chartPreviousClose,
      change: quote.regularMarketPrice - quote.chartPreviousClose,
      changePercent: ((quote.regularMarketPrice - quote.chartPreviousClose) / quote.chartPreviousClose * 100).toFixed(2),
      marketCap: quote.marketCap,
      _source: 'yahoo_finance',
    };
  } catch (err) {
    console.error(`  ⚠️ [YahooFinance] Failed for ${code} (${yahooSymbol}): ${err.message}`);
    return null;
  }
}


// ============================================================
// 统一的数据获取入口 — 三级降级策略
// ============================================================

async function fetchStockData(comp, targetDateStr) {
  const { code, yahoo } = comp;

  // --- 第一级: Naver K线图 API (获取价格、高低点) ---
  let chartData = await fetchNaverChart(code, targetDateStr);

  // --- 第二级: Naver HTML (获取 PER/PBR 等估值指标) ---
  let htmlData = await fetchNaverHtml(code);

  // --- 第三级: Yahoo Finance (如果上面两个都失败) ---
  let yahooData = null;
  if (!chartData && !htmlData) {
    yahooData = await fetchYahooFinance(yahoo, code);
  }

  // 合并数据 (优先级: Chart > HTML > Yahoo)
  let merged = {};
  
  if (chartData) {
    merged = { ...chartData };
  }
  if (htmlData) {
    // 用 htmlData 补充 chartData 缺少的字段
    for (const key of ['per', 'pbr', 'sharesOutstanding']) {
      if (htmlData[key] && !merged[key]) {
        merged[key] = htmlData[key];
      }
    }
    // 如果 chartData 没拿到但 htmlData 有价格
    if (!merged.price && htmlData.price) {
      merged.price = htmlData.price;
      merged.change = htmlData.change;
      merged.changePercent = htmlData.changePercent;
      merged._source = 'naver_html_only';
    }
  }
  
  // 计算市值: 股价 × 流通股数
  if (merged.price && merged.sharesOutstanding && !merged.marketCap) {
    merged.marketCap = merged.price * merged.sharesOutstanding;
    console.log(`  💰 [Calc] marketCap=${merged.marketCap} (price ${merged.price} × shares ${merged.sharesOutstanding})`);
  }
  if (yahooData) {
    merged = { ...yahooData };
  }

  // ====== 数据可信度校验（Sanity Check）======
  // 起因：2026-08-24 抓取时 Naver Chart API + Naver HTML 两个数据源同时对全部6家
  // 公司失效（疑似 Promise.all 并发12个请求触发 Naver 反爬/限流），只能全部
  // 兜底到 Yahoo Finance；但 Yahoo 对这些 KRX 中小盘个股返回的 regularMarketPrice
  // 严重失真（如 Shift Up 真实收盘¥31,800 被报成¥63,900，涨幅误报+101.58%），
  // 而 validate-data.mjs 当时未做涨跌幅异常校验，导致错误数据被直接发布上线。
  // 这里做两层防御：
  //   1) Yahoo 兜底数据一旦涨跌幅超过 ±15%（远低于韩国法定±30%涨跌停，因为这些
  //      公司历史上从未出现过如此级别的单日波动，Yahoo兜底数据已被证实不可信），
  //      直接判定为脏数据丢弃，让该公司当天数据缺失（前端展示"暂无"）好于错误数据。
  //   2) 任何来源的最终结果涨跌幅超过 KRX 法定涨跌停 ±30% 时，同样属于不可能事件，
  //      硬性丢弃（防御未来其它未知数据源问题）。
  if (merged.price && merged.changePercent != null) {
    const pct = parseFloat(merged.changePercent);
    if (!isNaN(pct)) {
      if (merged._source === 'yahoo_finance' && Math.abs(pct) > 15) {
        console.error(`  ❌ [Sanity] ${code}: Yahoo兜底数据涨跌幅 ${pct}% 超过可信阈值(±15%)，判定为脏数据并丢弃`);
        return null;
      }
      if (Math.abs(pct) > 30) {
        console.error(`  ❌ [Sanity] ${code}: 涨跌幅 ${pct}% 超过KRX涨跌停上限(±30%)，判定为脏数据并丢弃`);
        return null;
      }
    }
  }

  if (merged.price) {
    return merged;
  }
  
  return null;
}


// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('='.repeat(55));
  console.log('🎮 韩国游戏股价看板 — 数据抓取 v3');
  console.log(`🕒 运行时间: ${new Date().toISOString()}`);
  console.log('='.repeat(55));

  const targetDate = getLatestTradingDay();
  const dateStr = formatDate(targetDate);

  console.log(`\n📅 目标日期: ${dateStr} (${targetDate.getUTCMonth() + 1}月${targetDate.getUTCDate()}日)`);

  // ====== 每日一次保护：如果 latest.json 已是今天的数据则跳过 ======
  const latestFile = join(DATA_DIR, 'latest.json');
  if (existsSync(latestFile)) {
    try {
      const latest = JSON.parse(readFileSync(latestFile, 'utf-8'));
      // FORCE_REFETCH=1 可绕过每日一次保护（用于人工补数据/回补漏跑日）
      if (latest.meta?.date === dateStr && process.env.FORCE_REFETCH !== '1') {
        console.log(`\n⏭️ 今日 (${dateStr}) 数据已更新过，跳过重复执行（如需强制重跑请设置 FORCE_REFETCH=1）`);
        process.exit(0);
      }
    } catch (_) { /* 解析失败则继续执行 */ }
  }
  // ====== 每日一次保护 END ======
  
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 并行抓取所有公司数据
  // 注意：6家公司 × (Chart+HTML) = 最多12个并发请求同时打向 Naver，2026-08-24 曾
  // 因此触发 Naver 反爬/限流导致全部6家公司的 Chart+HTML 同时失效（只能兜底到不
  // 可靠的 Yahoo Finance，进而发布了错误股价）。这里给每个公司的请求错开一个小的
  // 启动延迟（stagger），避免瞬间并发峰值触发反爬，同时仍保持整体并行以控制耗时。
  console.log('\n📡 正在抓取股价数据...\n');
  const stockResults = await Promise.all(
    COMPANIES.map(async (comp, idx) => {
      if (idx > 0) await new Promise(r => setTimeout(r, idx * 400));
      console.log(`\n  ┌─ ${comp.name} (${comp.code})`);
      const data = await fetchStockData(comp, dateStr);
      if (data) {
        data.code = comp.code;
        data.name = comp.name;
        data.color = comp.color;
        console.log(
          `  │ ✅ 价格: ₩${formatPrice(data.price)}, ` +
          `PER: ${data.per || '-'}, PBR: ${data.pbr || '-'}, ` +
          `来源: ${data._source}`
        );
      } else {
        console.log(`  │ ❌ 所有数据源均失败`);
      }
      console.log(`  └─`);
      return data;
    })
  );

  const successCount = stockResults.filter(r => r !== null).length;
  console.log(`\n📊 成功: ${successCount}/${COMPANIES.length} 家公司`);
  
  if (successCount === 0) {
    console.error('\n❌ 所有公司数据获取失败！请检查网络或数据源是否可用。');
    process.exit(1);
  }

  // 抓取大盘指数（传入目标交易日，锁定"已完结交易日"收盘价，避免盘中数据错配）
  const indexResults = await fetchAllIndices(dateStr);

  // 构建看板数据包
  // Shift Up (462870) 必须是真正的 Shift Up 数据，绝不回退到其他公司
  const realShiftUp = stockResults.find(r => r?.code === '462870');
  
  const dashboardData = {
    meta: {
      date: dateStr,
      dateDisplay: `${targetDate.getUTCMonth() + 1}月（截至${targetDate.getUTCDate()}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance / Multi-source v3',
      updateCount: successCount,
    },

    // shiftUp 只用真实数据，失败则为 null 让前端展示"暂无"
    shiftUp: realShiftUp ? {
      code: '462870',   // 固定为 Shift Up 的代码
      name: 'Shift Up', // 固定名称
      color: '#ff6b9d',  // 固定颜色
      price: formatPrice(realShiftUp.price),
      previousClose: formatPrice(realShiftUp.yesterdayClose),
      high: formatPrice(realShiftUp.high || realShiftUp.price),
      low: formatPrice(realShiftUp.low || realShiftUp.price),
      change: realShiftUp.change ? Number(realShiftUp.change).toLocaleString() : '-',
      changePercent: realShiftUp.changePercent
        ? (parseFloat(realShiftUp.changePercent) > 0 ? '+' : '') + realShiftUp.changePercent + '%'
        : '-',
      changeClass: changeClass(realShiftUp.change),
    per: (realShiftUp.per && parseFloat(realShiftUp.per) > 0) ? realShiftUp.per : 'N/A',
    pbr: realShiftUp.pbr || '-',
      marketCap: formatWon(realShiftUp.marketCap),
      _allHistory: realShiftUp._allHistory || [], // 保存完整历史数据，用于修复历史月份
    } : null,

    companies: stockResults
      .filter(r => r && r.code !== '462870')
      .map(r => ({
        code: r.code,
        name: r.name,
        color: r.color,
        price: formatPrice(r.price),
        change: r.changePercent ? `${changeClass(r.change) === 'up' ? '+' : ''}${r.changePercent}%` : '-',
        changeClass: changeClass(r.change),
        per: (r.per && parseFloat(r.per) > 0) ? r.per : 'N/A',
      }))
      .sort((a, b) => (parseFloat(a.per) || 999) - (parseFloat(b.per) || 999)),

    perComparison: stockResults
      .filter(r => r && r.per && parseFloat(r.per) > 0)
      .map(r => ({
        code: r.code,
        name: r.name,
        color: r.color,
        price: formatPrice(r.price),
        per: parseFloat(r.per),
        perRaw: r.per,
      }))
      .sort((a, b) => a.per - b.per),

    chartData: [],
    
    // 大盘指数数据
    indices: indexResults,
  };

  // 图表数据 (使用 Shift Up 的历史数据)
  // 保留近2个月数据，支持前端按月份筛选显示
  if (realShiftUp && realShiftUp._allHistory && realShiftUp._allHistory.length > 0) {
    const currentMonth = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const prevMonth = String(targetDate.getUTCMonth()).padStart(2, '0') || '12';
    const currentYear = String(targetDate.getUTCFullYear());
    const prevYear = currentMonth === '01' ? String(targetDate.getUTCFullYear() - 1) : currentYear;
    const months = [prevYear + prevMonth, currentYear + currentMonth];
    const monthData = realShiftUp._allHistory
      .filter(h => months.includes(h.date.slice(0, 6)));
    
    dashboardData.chartData = monthData.map(h => ({
      date: h.date,
      label: `${parseInt(h.date.slice(4,6))}/${parseInt(h.date.slice(6,8))}`,
      price: h.close,
    }));
  }

  // 写入文件
  const outFile = join(DATA_DIR, `${dateStr}.json`);
  
  // 检查是否是某个月的最后一天（且文件已存在）
  // 如果是，且现有文件的数据比新数据更完整，则保留现有文件
  const isLastDayOfMonth = targetDate.getUTCDate() === new Date(targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, 0).getUTCDate();
  let shouldWrite = true;
  
  if (isLastDayOfMonth && existsSync(outFile)) {
    try {
      const existingData = JSON.parse(readFileSync(outFile, 'utf-8'));
      const existingCount = existingData.chartData?.length || 0;
      const newCount = dashboardData.chartData?.length || 0;
      
      if (existingCount > newCount) {
        console.log(`\n⚠️ ${dateStr} 是月末最后一天，现有数据(${existingCount}天)比新数据(${newCount}天)更完整，保留现有文件`);
        shouldWrite = false;
        // 仍然更新dashboardData的chartData为现有数据，确保latest.json正确
        dashboardData.chartData = existingData.chartData;
      }
    } catch (err) {
      console.warn(`⚠️ 检查现有文件失败: ${err.message}`);
    }
  }
  
  if (shouldWrite) {
    writeFileSync(outFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
    console.log(`\n✅ 数据已保存: ${outFile}`);
  } else {
    // 更新fetchedAt时间戳
    const existingData = JSON.parse(readFileSync(outFile, 'utf-8'));
    existingData.meta.fetchedAt = new Date().toISOString();
    writeFileSync(outFile, JSON.stringify(existingData, null, 2), 'utf-8');
    console.log(`✅ 已更新 ${outFile} 的时间戳`);
  }

  writeFileSync(join(DATA_DIR, 'latest.json'), JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`✅ 最新数据已更新: latest.json`);

  updateDatesList(dateStr);

  // 自动更新 content.json 的 compareChart
  updateCompareChart(stockResults, targetDate);

  // ============================================================
  // 修复历史月份数据完整性
  // 当进入新月份后，上个月的JSON文件可能被截断（Naver API只返回最近60天）
  // 这里用上个月的完整历史数据重新生成上个月的JSON文件
  // ============================================================
  await fixHistoricalMonthData(realShiftUp?._allHistory || [], targetDate);

  // ============================================================
  // 补齐"漏跑日"的历史快照
  // 只要某天的 workflow 没触发/失败（如 8/11 那次），该交易日的日快照就永久缺失，
  // 历史下拉会出现空洞（8/7 → 8/11 之间少了 8/10）。fixHistoricalMonthData 只修
  // 已存在文件的 chartData，不会新建文件，所以这里补上"新建缺失日文件"的能力。
  // ============================================================
  await backfillMissingDailyFiles(stockResults, targetDate);
  
  console.log(`\n🎉 完成! 共更新 ${successCount}/${COMPANIES.length} 家公司`);
  if (dashboardData.shiftUp) {
    console.log(
      `   Shift Up: ₩${dashboardData.shiftUp.price}, ` +
      `PER: ${dashboardData.shiftUp.per}, PBR: ${dashboardData.shiftUp.pbr}`
    );
  }
  console.log(
    `   其他: ${dashboardData.companies.map(c => `${c.name}:${c.price}`).join(', ')}`
  );
}

/**
 * 修复历史月份的JSON文件，确保chartData完整
 * 原理：用_allHistory中的完整数据重新生成上个月和当前月的历史JSON文件
 * 注意：也修复当前月，因为月初生成当月文件时可能数据不完整
 */
async function fixHistoricalMonthData(allHistory, targetDate) {
  if (!allHistory || allHistory.length === 0) return;

  const currentYear = String(targetDate.getUTCFullYear());
  const currentMonthNum = targetDate.getUTCMonth() + 1; // 1-12
  const currentMonth = String(currentMonthNum).padStart(2, '0');
  
  // 计算上个月
  let prevMonthNum = targetDate.getUTCMonth(); // 0-11
  let prevYear = targetDate.getUTCFullYear();
  if (prevMonthNum === 0) {
    prevMonthNum = 12;
    prevYear -= 1;
  }
  const prevMonth = String(prevMonthNum).padStart(2, '0');
  
  // 需要修复的月份列表（上个月 + 当前月）
  const monthsToFix = [
    { prefix: `${prevYear}${prevMonth}`, name: `${prevYear}${prevMonth}` },
    { prefix: `${currentYear}${currentMonth}`, name: `${currentYear}${currentMonth}` },
  ];
  
  for (const { prefix, name } of monthsToFix) {
    // 从_allHistory中提取该月份的完整数据
    const monthHistory = allHistory
      .filter(h => h.date.startsWith(prefix))
      .sort((a, b) => a.date.localeCompare(b.date));
    
    if (monthHistory.length === 0) {
      console.log(`\n📅 无${name}月份数据需要修复`);
      continue;
    }
    
    console.log(`\n🔧 修复${name}月份历史数据 (${monthHistory.length}个交易日)`);
    
    // 构建完整的chartData
    const fullChartData = monthHistory.map(h => ({
      date: h.date,
      label: `${parseInt(h.date.slice(4,6))}/${parseInt(h.date.slice(6,8))}`,
      price: h.close,
    }));
    
    // 找到所有该月份的历史JSON文件
    const files = readdirSync(DATA_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json') && f !== 'latest.json');
    
    let fixedCount = 0;
    for (const file of files) {
      const filePath = join(DATA_DIR, file);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        const existingCount = data.chartData?.length || 0;
        
        // 只修复chartData不完整的文件（新数据比现有数据多）
        if (existingCount < fullChartData.length) {
          // 截断到该文件对应的日期
          const fileDate = file.replace('.json', '');
          const fileDay = parseInt(fileDate.slice(6, 8), 10);
          const truncatedData = fullChartData.filter(d => {
            const day = parseInt(d.date.slice(6, 8), 10);
            return day <= fileDay;
          });
          
          data.chartData = truncatedData;
          writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
          console.log(`  ✅ ${file}: ${existingCount} → ${truncatedData.length} 天`);
          fixedCount++;
        }
      } catch (err) {
        console.warn(`  ⚠️ 跳过 ${file}: ${err.message}`);
      }
    }
    
    if (fixedCount === 0) {
      console.log(`  ✓ ${name}月份所有文件已完整，无需修复`);
    } else {
      console.log(`  📊 共修复 ${fixedCount} 个文件`);
    }
  }
}

/**
 * 补齐"漏跑日"的日快照文件（自愈）
 * 场景：某天 workflow 未触发或中途失败 → 该交易日的 data/YYYYMMDD.json 永久缺失，
 *       前端历史下拉出现空洞（例：8/11 那次漏跑，8/10 快照至今缺失）。
 * 原理：Naver K线接口一次返回 80 个交易日，各公司 _allHistory 里已有历史收盘价，
 *       用它重建缺失日的快照；PER/PBR/市值按"收盘价比例"折算（月内 EPS/BVPS/股本视为不变），
 *       并在 meta 中标记 backfilled，便于区分实时抓取与事后补齐。
 */
async function backfillMissingDailyFiles(stockResults, targetDate) {
  const shiftUp = stockResults.find(r => r?.code === '462870');
  const suHistory = shiftUp?._allHistory || [];
  if (suHistory.length === 0) {
    console.log('\n📅 无历史数据，跳过漏跑日补齐');
    return;
  }

  const dateStr = formatDate(targetDate);
  const curPrefix = dateStr.slice(0, 6);
  const prevPrefix = formatDate(
    new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth() - 1, 1))
  ).slice(0, 6);
  const monthPrefixes = [prevPrefix, curPrefix];

  // Naver 返回的历史日期本身就是"真实交易日"，无需再依赖手工休市日表
  const tradingDays = suHistory
    .map(h => h.date)
    .filter(d => monthPrefixes.includes(d.slice(0, 6)) && d < dateStr)
    .sort();

  const missing = tradingDays.filter(
    d => !KRX_HOLIDAYS_2026.has(d) && !existsSync(join(DATA_DIR, `${d}.json`))
  );

  if (missing.length === 0) {
    console.log('\n📅 近两月无漏跑日，历史快照完整');
    return;
  }

  console.log(`\n🩹 检测到 ${missing.length} 个漏跑日缺少快照: ${missing.join(', ')}`);

  // 指数历史（仅在确有缺口时才多发这两个请求）
  const indexHistories = {};
  for (const idx of INDICES) {
    const chart = await fetchNaverChart(idx.code, dateStr);
    if (chart?._allHistory?.length) {
      indexHistories[idx.code] = { name: idx.name, history: chart._allHistory };
    }
  }

  let created = 0;
  for (const d of missing) {
    const snapshot = buildHistoricalSnapshot(d, stockResults, indexHistories, monthPrefixes);
    if (!snapshot) {
      console.warn(`  ⚠️ ${d}: 历史数据不足，无法补齐`);
      continue;
    }
    writeFileSync(join(DATA_DIR, `${d}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
    updateDatesList(d);
    console.log(`  ✅ 已补齐 ${d}.json（Shift Up ₩${snapshot.shiftUp.price}, ${snapshot.shiftUp.changePercent}）`);
    created++;
  }

  if (created > 0) console.log(`  🩹 共补齐 ${created} 个漏跑日快照`);
}

/**
 * 用各公司历史收盘价重建某个历史交易日的快照
 * 返回 null 表示历史数据不足（例如 Shift Up 当日无数据）
 */
function buildHistoricalSnapshot(dateStr, stockResults, indexHistories, monthPrefixes) {
  const rebuilt = [];

  for (const r of stockResults) {
    const hist = r?._allHistory;
    if (!hist || hist.length === 0) continue;
    const idx = hist.findIndex(h => h.date === dateStr);
    if (idx < 0) continue;

    const cur = hist[idx];
    const prev = idx > 0 ? hist[idx - 1] : null;
    const change = prev ? cur.close - prev.close : 0;
    const changePercent = prev && prev.close > 0 ? ((change / prev.close) * 100).toFixed(2) : null;

    // 估值指标折算比例：当日收盘 / 最新收盘
    const ratio = r.price > 0 ? cur.close / r.price : 1;
    const perNum = parseFloat(r.per);
    const pbrNum = parseFloat(r.pbr);

    rebuilt.push({
      code: r.code,
      name: r.name,
      color: r.color,
      close: cur.close,
      high: cur.high || cur.close,
      low: cur.low || cur.close,
      prevClose: prev ? prev.close : cur.close,
      change,
      changePercent,
      per: perNum > 0 ? (perNum * ratio).toFixed(2) : null,
      pbr: pbrNum > 0 ? (pbrNum * ratio).toFixed(2) : null,
      marketCap: r.marketCap ? r.marketCap * ratio : null,
    });
  }

  const su = rebuilt.find(s => s.code === '462870');
  if (!su) return null;

  const day = parseInt(dateStr.slice(6, 8), 10);
  const month = parseInt(dateStr.slice(4, 6), 10);

  const suHistory = stockResults.find(r => r?.code === '462870')._allHistory;
  // 关键：历史快照内不得出现"该日之后"的数据，否则查看历史日期时会泄漏未来行情
  const historyUpToDate = suHistory.filter(h => h.date <= dateStr);
  const chartData = historyUpToDate
    .filter(h => monthPrefixes.includes(h.date.slice(0, 6)))
    .map(h => ({
      date: h.date,
      label: `${parseInt(h.date.slice(4, 6))}/${parseInt(h.date.slice(6, 8))}`,
      price: h.close,
    }));

  const indices = [];
  for (const [code, info] of Object.entries(indexHistories)) {
    const i = info.history.findIndex(h => h.date === dateStr);
    if (i < 0) continue;
    const cur = info.history[i];
    const prev = i > 0 ? info.history[i - 1] : null;
    const change = prev ? cur.close - prev.close : 0;
    indices.push({
      code,
      name: info.name,
      price: Number(cur.close).toFixed(2),
      change: Number(change).toFixed(2),
      changePercent: prev && prev.close > 0 ? ((change / prev.close) * 100).toFixed(2) : '0.00',
      changeClass: changeClass(change),
    });
  }

  const others = rebuilt.filter(s => s.code !== '462870');

  return {
    meta: {
      date: dateStr,
      dateDisplay: `${month}月（截至${day}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance / 漏跑日回补（估值指标按收盘价比例折算）',
      updateCount: rebuilt.length,
      backfilled: true,
    },
    shiftUp: {
      code: '462870',
      name: 'Shift Up',
      color: '#ff6b9d',
      price: formatPrice(su.close),
      previousClose: formatPrice(su.prevClose),
      high: formatPrice(su.high),
      low: formatPrice(su.low),
      change: Number(su.change).toLocaleString(),
      changePercent: su.changePercent
        ? (parseFloat(su.changePercent) > 0 ? '+' : '') + su.changePercent + '%'
        : '-',
      changeClass: changeClass(su.change),
      per: su.per || 'N/A',
      pbr: su.pbr || '-',
      marketCap: formatWon(su.marketCap),
      _allHistory: historyUpToDate,
    },
    companies: others
      .map(s => ({
        code: s.code,
        name: s.name,
        color: s.color,
        price: formatPrice(s.close),
        change: s.changePercent ? `${changeClass(s.change) === 'up' ? '+' : ''}${s.changePercent}%` : '-',
        changeClass: changeClass(s.change),
        per: s.per || 'N/A',
      }))
      .sort((a, b) => (parseFloat(a.per) || 999) - (parseFloat(b.per) || 999)),
    perComparison: rebuilt
      .filter(s => s.per && parseFloat(s.per) > 0)
      .map(s => ({
        code: s.code,
        name: s.name,
        color: s.color,
        price: formatPrice(s.close),
        per: parseFloat(s.per),
        perRaw: s.per,
      }))
      .sort((a, b) => a.per - b.per),
    chartData,
    indices,
  };
}

function updateDatesList(newDate) {
  const datesFile = join(DATA_DIR, 'dates.json');
  let dates = [];

  if (existsSync(datesFile)) {
    try {
      const raw = JSON.parse(readFileSync(datesFile, 'utf-8'));
      dates = Array.isArray(raw) ? raw : (raw.dates || []);
    } catch {}
  }

  if (!dates.includes(newDate)) {
    dates.push(newDate);
    dates.sort().reverse();
    dates = dates.slice(0, 60);
  }

  writeFileSync(datesFile, JSON.stringify({ dates }, null, 2), 'utf-8');
  console.log(`✅ 日期列表已更新: ${dates.length} 个存档`);
}

// ============================================================
// 自动更新 content.json 的 compareChart
// 每日数据抓取后，计算各公司相对基准日的累积涨跌幅并追加
// ============================================================

// 2026年KRX休市日（不得出现在compareChart标签中）
const KRX_HOLIDAYS_2026 = new Set([
  '20260101', // 元旦
  '20260216', '20260217', '20260218', // 春节
  '20260302', // 三一节
  '20260501', // 劳动节
  '20260505', // 儿童节
  '20260525', // 佛诞日
  '20260603', // 地方选举日
  '20260717', // 制宪节（18年来首次恢复公休日）
  '20260817', // 光复节
  '20260924', '20260925', // 秋夕
  '20261005', // 开天节
  '20261009', // 韩文日
  '20261225', // 圣诞
  '20261231', // 年末休市
]);

// compareChart 名称 → stockResult 名称 映射
const CHART_NAME_MAP = {
  'Shift Up': 'Shift Up',
  'Nexon': 'Nexon Games',
  'Netmarble': 'Netmarble',
  'NC': 'NC',
  'Krafton': 'Krafton',
  'P.Abyss': 'Pearl Abyss',
};

// compareChart 基准日：动态获取当月首个交易日
// 规则：每月重置，基准日为当月首个交易日（跳过周末和KRX休市日）
function getFirstTradingDayOfMonth(year, month) {
  // month 是 0-based (0=1月)
  const candidates = [];
  for (let day = 1; day <= 10; day++) { // 最多看前10天，足够覆盖月初假期
    const d = new Date(Date.UTC(year, month, day));
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue; // 跳过周末
    const dateStr = formatDate(d);
    if (KRX_HOLIDAYS_2026.has(dateStr)) continue; // 跳过休市日
    candidates.push(dateStr);
    break; // 找到第一个即停止
  }
  return candidates[0] || null;
}

function updateCompareChart(stockResults, targetDate) {
  const contentFile = join(DATA_DIR, 'content.json');
  if (!existsSync(contentFile)) {
    console.log('📊 content.json 不存在，跳过 compareChart 更新');
    return;
  }

  let content;
  try {
    content = JSON.parse(readFileSync(contentFile, 'utf-8'));
  } catch (err) {
    console.error(`📊 读取 content.json 失败: ${err.message}`);
    return;
  }

  if (!content.compareChart || !content.compareChart.datasets) {
    console.log('📊 content.json 中无 compareChart，跳过');
    return;
  }

  const dateStr = formatDate(targetDate);

  // 跳过KRX休市日
  if (KRX_HOLIDAYS_2026.has(dateStr)) {
    console.log(`📊 ${dateStr} 是KRX休市日，跳过 compareChart 更新`);
    return;
  }

  const chart = content.compareChart;
  const label = `${targetDate.getUTCMonth() + 1}/${targetDate.getUTCDate()}`;

  // 幂等：如果标签已存在则更新（而非跳过），以修复盘中计算错误
  const existingIndex = chart.labels.indexOf(label);
  if (existingIndex !== -1) {
    // 标签已存在，更新数据而非追加
    console.log(`📊 compareChart: ${label} 已存在，更新数据`);
    // 移除旧标签和数据点（从该位置开始）
    chart.labels.splice(existingIndex, 1);
    for (const ds of chart.datasets) {
      ds.data.splice(existingIndex, 1);
    }
  }

  // 动态获取当月首个交易日作为基准日
  const compareBaseDate = getFirstTradingDayOfMonth(targetDate.getUTCFullYear(), targetDate.getUTCMonth());
  console.log(`📊 compareChart 基准日: ${compareBaseDate}（${targetDate.getUTCMonth() + 1}月首个交易日）`);

  // 检测是否跨月：当前 labels 中是否已存在当月日期
  const currentMonthPrefix = `${targetDate.getUTCMonth() + 1}/`;
  const hasCurrentMonthData = chart.labels.some(l => l.startsWith(currentMonthPrefix));

  // 追加标签
  chart.labels.push(label);

  let updatedCount = 0;

  for (const dataset of chart.datasets) {
    const stockName = CHART_NAME_MAP[dataset.label] || dataset.label;
    const stockResult = stockResults.find(r => r?.name === stockName);

    if (!stockResult || !stockResult.price) {
      // 跨月首个交易日重置为0，否则沿用上一个值
      if (!hasCurrentMonthData) {
        dataset.data.push(0);
        console.log(`  📊 ${dataset.label}: 新月首日，重置为 0%`);
      } else {
        const lastVal = dataset.data.length > 0 ? dataset.data[dataset.data.length - 1] : 0;
        dataset.data.push(lastVal);
        console.log(`  📊 ${dataset.label}: 无数据，沿用 ${lastVal}%`);
      }
      continue;
    }

    // 策略1：从 _allHistory 直接计算（最准确）
    if (stockResult._allHistory && stockResult._allHistory.length > 0) {
      const baseEntry = stockResult._allHistory.find(h => h.date === compareBaseDate);
      const targetEntry = stockResult._allHistory.find(h => h.date === dateStr);

      if (baseEntry && targetEntry) {
        const basePrice = baseEntry.close;
        const targetPrice = targetEntry.close;
        const cumulative = ((targetPrice - basePrice) / basePrice) * 100;
        const rounded = Math.round(cumulative * 100) / 100;
        dataset.data.push(rounded);
        console.log(`  📊 ${dataset.label}: ${rounded}% (基准₩${basePrice.toLocaleString()} → ₩${targetPrice.toLocaleString()}, 基准日${compareBaseDate})`);
        updatedCount++;
        continue;
      }
    }

    // 策略2：增量计算（_allHistory 不可用时的回退方案）
    // 原理：已知昨日累积%和昨收价，反推基准价，再用今日收盘算新累积%
    // 注意：跨月时基准价变了，增量法会不准确，应尽量用策略1
    if (dataset.data.length > 0 && stockResult.yesterdayClose) {
      const prevCumulative = dataset.data[dataset.data.length - 1];
      const basePrice = stockResult.yesterdayClose / (1 + prevCumulative / 100);
      const cumulative = ((stockResult.price - basePrice) / basePrice) * 100;
      const rounded = Math.round(cumulative * 100) / 100;
      dataset.data.push(rounded);
      console.log(`  📊 ${dataset.label}: ${rounded}% (增量回退计算)`);
      updatedCount++;
      continue;
    }

    // 策略3：最终回退
    const lastVal = dataset.data.length > 0 ? dataset.data[dataset.data.length - 1] : 0;
    dataset.data.push(lastVal);
    console.log(`  📊 ${dataset.label}: 无法计算，沿用 ${lastVal}%`);
  }

  // 数据长度一致性校验与修复（防止并发/异常导致data与labels错位）
  const labelsLen = chart.labels.length;
  for (const ds of chart.datasets) {
    if (ds.data.length !== labelsLen) {
      console.warn(`⚠️ ${ds.label} data长度(${ds.data.length})与labels(${labelsLen})不一致，自动修复`);
      while (ds.data.length > labelsLen) {
        ds.data.pop();
      }
      while (ds.data.length < labelsLen) {
        ds.data.push(ds.data.length > 0 ? ds.data[ds.data.length - 1] : 0);
      }
    }
  }

  // 漏跑日补齐：把当月缺失的交易日按时间顺序插回（与日快照补齐同理）
  const backfilled = backfillCompareChartGaps(chart, stockResults, targetDate, compareBaseDate);

  // 更新 meta.updatedAt
  const yyyy = targetDate.getUTCFullYear();
  const mm = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getUTCDate()).padStart(2, '0');
  content.meta.updatedAt = `${yyyy}-${mm}-${dd}`;

  writeFileSync(contentFile, JSON.stringify(content, null, 2), 'utf-8');
  console.log(`✅ compareChart 已更新: 新增 ${label}，${updatedCount} 家公司使用精确计算`);
  if (backfilled.length > 0) {
    console.log(`🩹 compareChart 已回补漏跑日: ${backfilled.join(', ')}`);
  }
}

/**
 * 回补 compareChart 中当月缺失的交易日
 * 漏跑一天不仅少一个日快照，对比图也会缺一个数据点（8/7 直接连到 8/11）。
 * 这里用各公司 _allHistory 精确计算并按日期顺序插入，保证折线连续。
 */
function backfillCompareChartGaps(chart, stockResults, targetDate, compareBaseDate) {
  const shiftUp = stockResults.find(r => r?.code === '462870');
  const suHistory = shiftUp?._allHistory || [];
  if (suHistory.length === 0 || !compareBaseDate) return [];

  const dateStr = formatDate(targetDate);
  const monthPrefix = dateStr.slice(0, 6);
  const curMonth = targetDate.getUTCMonth() + 1;
  const inserted = [];

  const monthTradingDays = suHistory
    .map(h => h.date)
    .filter(d => d.startsWith(monthPrefix) && d >= compareBaseDate && d <= dateStr)
    .sort();

  for (const d of monthTradingDays) {
    const day = parseInt(d.slice(6, 8), 10);
    const label = `${curMonth}/${day}`;
    if (chart.labels.includes(label)) continue;

    // 插入位置：当月已有标签中第一个"日期更大"的位置；找不到则追加到末尾
    let insertAt = chart.labels.length;
    for (let i = 0; i < chart.labels.length; i++) {
      const m = String(chart.labels[i]).match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!m) continue;
      if (parseInt(m[1], 10) === curMonth && parseInt(m[2], 10) > day) {
        insertAt = i;
        break;
      }
    }

    chart.labels.splice(insertAt, 0, label);

    for (const dataset of chart.datasets) {
      const stockName = CHART_NAME_MAP[dataset.label] || dataset.label;
      const stockResult = stockResults.find(r => r?.name === stockName);
      const hist = stockResult?._allHistory || [];
      const baseEntry = hist.find(h => h.date === compareBaseDate);
      const targetEntry = hist.find(h => h.date === d);

      let value;
      if (baseEntry && targetEntry && baseEntry.close > 0) {
        value = Math.round(((targetEntry.close - baseEntry.close) / baseEntry.close) * 100 * 100) / 100;
      } else {
        // 无历史可算时沿用相邻值，避免折线断裂
        value = insertAt > 0 ? dataset.data[insertAt - 1] : (dataset.data[0] ?? 0);
      }
      dataset.data.splice(insertAt, 0, value);
    }

    inserted.push(label);
  }

  return inserted;
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
