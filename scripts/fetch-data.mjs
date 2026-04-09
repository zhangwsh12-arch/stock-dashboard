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

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// ============================================================
// 公司配置
// ============================================================
const COMPANIES = [
  { code: '462870', name: 'Shift Up',       nameKr: '시프트업',    color: '#ff6b9d', yahoo: '462870.KQ' },
  { code: '225570', name: 'Nexon Games',    nameKr: '넥슨게임즈',   color: '#22c55e', yahoo: '225570.KS' },
  { code: '251270', name: 'Netmarble',      nameKr: '넷마블',        color: '#ef4444', yahoo: '251270.KS' },
  { code: '036570', name: 'NCSoft',         nameKr: '엔씨소프트',    color: '#3b82f6', yahoo: '036570.KS' },
  { code: '259960', name: 'Krafton',        nameKr: '크래프톤',     color: '#f59e0b', yahoo: '259960.KQ' },
  { code: '263750', name: 'Pearl Abyss',    nameKr: '펄어비스',     color: '#ec4899', yahoo: '263750.KS' },
];

// ============================================================
// 工具函数
// ============================================================
function getLatestTradingDay() {
  const d = new Date();
  // 韩国时间 UTC+9，上午9点到下午3点为交易时间
  const koreaHour = d.getUTCHours() + 9;
  
  // 始终取前一个交易日收盘（看板显示昨收数据）
  // 如果还没到当天收盘(韩国时间15点=UTC 6点)，取前一个交易日
  if (koreaHour >= 6) d.setUTCDate(d.getUTCDate() - 1);
  
  const day = d.getUTCDay();
  // 周末回退到周五
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2);  // 周日 -> 周五
  if (day === 6) d.setUTCDate(d.getUTCDate() - 1);  // 周六 -> 周五
  
  return d;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatPrice(p) {
  if (!p && p !== 0) return '-';
  return Math.round(Number(p)).toLocaleString('en-US');
}

function formatWon(n) {
  if (!n || isNaN(n)) return '-';
  const num = Number(n);
  if (num >= 1000000000000) return `≈ ${(num / 1000000000000).toFixed(1)}兆元`;
  if (num >= 100000000) return `≈ ${(num / 100000000).toFixed(1)}亿元`;
  if (num >= 10000) return `≈ ${Math.round(num / 10000).toLocaleString()}亿 ₩`;
  return `≈ ${Math.round(num).toLocaleString()}₩`;
}

function changeClass(change) {
  const c = parseFloat(change);
  if (c > 0) return 'up';
  if (c < 0) return 'down';
  return 'neutral';
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

async function fetchNaverChart(code) {
  try {
    // requestType=0 + count=15 拿最近15天数据（含今天）
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=15&requestType=0`;
    console.log(`  📊 [NaverChart] Fetching: ${code} (requestType=0, count=15)`);
    
    const resp = await fetchWithRetry(url);
    const buf = await resp.arrayBuffer();
    let text = new TextDecoder('euc-kr').decode(buf);
    
    // requestType=0 返回格式可能包含前后空白/引号，需要清理
    text = text.trim();
    
    // 找到第一个 '[' 开始的位置（跳过可能的 BOM 或前导字符）
    const startIdx = text.indexOf('[');
    if (startIdx > 0) text = text.substring(startIdx);

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
    
    // 核心逻辑：取倒数第2条(前一个交易日收盘价)
    // 最后一条是今天的盘中数据，倒数第二条才是昨天收盘
    const today = allData[allData.length - 1];
    const yesterday = allData[allData.length - 2];
    const dayBefore = allData.length > 2 ? allData[allData.length - 3] : yesterday;
    
    // price = 前一日收盘价 (看板要求显示昨收，非实时价格)
    const targetPrice = yesterday.close;
    const prevPrice = dayBefore.close;

    console.log(`  ✅ [NaverChart] ${code}: 昨收(${yesterday.date})=${targetPrice.toLocaleString()}, change=${targetPrice - prevPrice}`);
    
    return {
      price: targetPrice,                    // 前一日收盘价（主显示）
      date: yesterday.date,                  // 数据日期
      open: yesterday.open,
      high: yesterday.high,
      low: yesterday.low,
      yesterdayClose: prevPrice,             // 前前日收盘（用于算变化）
      change: targetPrice - prevPrice,       // 较前日涨跌额
      changePercent: prevPrice > 0 ? (((targetPrice - prevPrice) / prevPrice) * 100).toFixed(2) : null,
      volume: yesterday.volume,
      _source: 'naver_chart_api_v2',
      _allHistory: allData.slice(-30),       // 走势图用
      _todayData: today,                     // 今日数据备用
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

    // ---- 方法3: PER — Naver 表格有多列(当期/当期累计等)，取最后一个有效数值列 ----
    // 实际结构: <strong>PER(배)</strong></th> 后面跟多个 <td>, 第3个 td 是最新准确值
    // 例如 Shift Up: [空] | 23.34 | 10.89(investing=9.80) → 取 10.89
    const perMatch = html.match(/<strong>PER/);
    if (perMatch) {
      // 从 PER 开始，提取该行所有 td 的值
      const perArea = html.substring(perMatch.index, perMatch.index + 800);
      const allTdValues = [...perArea.matchAll(/<td[^>]*>\s*([\d.]+|-|&nbsp;)\s*<\/td>/g)]
        .map(m => m[1])
        .filter(v => v !== '-' && v !== '&nbsp;' && v !== '');
      if (allTdValues.length > 0) {
        result.per = allTdValues[allTdValues.length - 1];  // 取最后一列
        console.log(`  ✅ [NaverHTML-PER] per=${result.per} (all cols: [${allTdValues.join(', ')}])`);
      }
    }

    // ---- 方法4: PBR —— 同理，取最后一列 ----
    const pbrMatch = html.match(/<strong>PBR/);
    if (pbrMatch) {
      const pbrArea = html.substring(pbrMatch.index, pbrMatch.index + 600);
      const allPbrValues = [...pbrArea.matchAll(/<td[^>]*>\s*([\d.]+|-|&nbsp;)\s*<\/td>/g)]
        .map(m => m[1])
        .filter(v => v !== '-' && v !== '&nbsp;' && v !== '');
      if (allPbrValues.length > 0) {
        result.pbr = allPbrValues[allPbrValues.length - 1];  // 取最后一列
        console.log(`  ✅ [NaverHTML-PBR] pbr=${result.pbr} (all cols: [${allPbrValues.join(', ')}])`);
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

async function fetchStockData(comp) {
  const { code, yahoo } = comp;

  // --- 第一级: Naver K线图 API (获取价格、高低点) ---
  let chartData = await fetchNaverChart(code);

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

  console.log(`\n📅 目标日期: ${dateStr} (${targetDate.getMonth() + 1}月${targetDate.getDate()}日)`);
  
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 并行抓取所有公司数据
  console.log('\n📡 正在抓取股价数据...\n');
  const stockResults = await Promise.all(
    COMPANIES.map(async (comp) => {
      console.log(`\n  ┌─ ${comp.name} (${comp.code})`);
      const data = await fetchStockData(comp);
      if (data) {
        data.code = comp.code;
        data.name = comp.name;
        data.nameKr = comp.nameKr;
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

  // 构建看板数据包
  // Shift Up (462870) 必须是真正的 Shift Up 数据，绝不回退到其他公司
  const realShiftUp = stockResults.find(r => r?.code === '462870');
  
  const dashboardData = {
    meta: {
      date: dateStr,
      dateDisplay: `${targetDate.getMonth() + 1}月（截至${targetDate.getDate()}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance / Multi-source v3',
      updateCount: successCount,
    },

    // shiftUp 只用真实数据，失败则为 null 让前端展示"暂无"
    shiftUp: realShiftUp ? {
      code: '462870',   // 固定为 Shift Up 的代码
      name: 'Shift Up', // 固定名称
      nameKr: '시프트업',
      color: '#ff6b9d',  // 固定颜色
      price: formatPrice(realShiftUp.price),
      previousClose: formatPrice(realShiftUp.yesterdayClose),
      high: formatPrice(realShiftUp.high || realShiftUp.price),
      low: formatPrice(realShiftUp.low || realShiftUp.price),
      change: realShiftUp.change ? Number(realShiftUp.change).toLocaleString() : '-',
      changePercent: realShiftUp.changePercent || '-',
      changeClass: changeClass(realShiftUp.change),
      per: realShiftUp.per || '-',
      pbr: realShiftUp.pbr || '-',
      marketCap: formatWon(realShiftUp.marketCap),
    } : null,

    companies: stockResults
      .filter(r => r && r.code !== '462870')
      .map(r => ({
        code: r.code,
        name: r.name,
        nameKr: r.nameKr,
        color: r.color,
        price: formatPrice(r.price),
        change: r.changePercent ? `${changeClass(r.change) === 'up' ? '+' : ''}${r.changePercent}%` : '-',
        changeClass: changeClass(r.change),
        per: r.per || '-',
      }))
      .sort((a, b) => (parseFloat(a.per) || 999) - (parseFloat(b.per) || 999)),

    perComparison: stockResults
      .filter(r => r && r.per)
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
  };

  // 图表数据 (使用 Shift Up 的历史数据)
  if (realShiftUp && realShiftUp._allHistory && realShiftUp._allHistory.length > 0) {
    dashboardData.chartData = realShiftUp._allHistory.map(h => ({
      date: h.date,
      label: `${parseInt(h.date.slice(4,6))}/${parseInt(h.date.slice(6,8))}`,
      price: h.close,
    }));
  }

  // 写入文件
  const outFile = join(DATA_DIR, `${dateStr}.json`);
  writeFileSync(outFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`\n✅ 数据已保存: ${outFile}`);

  const latestFile = join(DATA_DIR, 'latest.json');
  writeFileSync(latestFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`✅ 最新数据已更新: latest.json`);

  updateDatesList(dateStr);
  
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

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
