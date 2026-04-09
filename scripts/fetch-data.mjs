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
  
  // 如果还没到当天收盘(韩国时间15点=UTC 6点)，取前一个交易日
  if (koreaHour < 6) d.setUTCDate(d.getUTCDate() - 1);
  
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
  if (num >= 1000000000000) return `≈ ${(num / 1000000000000).toFixed(1)}조원`;
  if (num >= 100000000) return `≈ ${(num / 100000000).toFixed(1)}억원`;
  if (num >= 10000) return `≈ ${Math.round(num / 10000).toLocaleString()}억 ₩`;
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
// 数据源1: Naver K线图 JSON API (最可靠)
// URL: https://fchart.stock.naver.com/siseJson.naver?symbol=CODE&timeframe=day&count=5&requestType=1
// 返回: [[日期, 开盘, 高, 低, 收盘, 成交量], ...]
// ============================================================

async function fetchNaverChart(code) {
  // KOSDAQ 股票代码需要加前缀 (KQ后缀市场)
  const isKosdaq = ['462870', '259960'].includes(code);
  
  try {
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=5&requestType=1`;
    console.log(`  📊 [NaverChart] Fetching: ${code}${isKosdaq ? ' (KOSDAQ)' : ''}`);
    
    const resp = await fetchWithRetry(url);
    const text = await resp.text();
    
    console.log(`  🔍 [NaverChart] Response length: ${text.length}, preview: ${text.substring(0, 200)}`);
    
    // 解析每行JSON数组
    const lines = text.trim().split('\n').filter(l => l.startsWith('['));
    const allData = [];
    
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Array.isArray(row)) {
          for (let i = 1; i < row.length; i++) {
            const item = row[i];
            allData.push({
              date: item[0],
              open: parseInt(item[1]),
              high: parseInt(item[2]),
              low: parseInt(item[3]),
              close: parseInt(item[4]),
              volume: parseInt(item[5] || 0),
            });
          }
        }
      } catch {}
    }

    if (allData.length === 0) throw new Error('No data rows');
    
    // 最新的一条就是当前交易日数据
    const latest = allData[allData.length - 1];
    const prevClose = allData.length > 1 ? allData[allData.length - 2].close : latest.open;
    
    console.log(`  ✅ [NaverChart] ${code}: close=${latest.close}, high=${latest.high}, low=${latest.low}`);
    
    return {
      price: latest.close,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      yesterdayClose: prevClose,
      change: latest.close - prevClose,
      changePercent: prevClose > 0 ? ((latest.close - prevClose) / prevClose * 100).toFixed(2) : null,
      volume: latest.volume,
      _source: 'naver_chart_api',
      _allHistory: allData.slice(-30),
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

    const html = await resp.text();
    const result = {};

    // ---- 方法A: 从内嵌 JS 变量提取 ----
    // Naver 页面通常在 script 标签里有 _itemInfo 或类似变量
    
    // 模式1: _itemContent = {...}
    let m = html.match(/_itemContent\s*=\s*(\{[^;]+?\});/s);
    if (m) {
      try {
        const cleaned = m[1].replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"');
        const content = JSON.parse(cleaned);
        if (content.cv) result.price = Number(content.cv);       // 当前价
        if (content.nv) result.yesterdayClose = Number(content.nv);
        if (content.hv) result.high = Number(content.hv);
        if (content.lv) result.low = Number(content.lv);
        if (content.cr) result.change = Number(content.cr);
        if (content.ra) result.changePercent = content.ra;
        if (content.per) result.per = String(content.per);
        if (content.pbr) result.pbr = String(content.pbr);
        if (content.mv) result.marketCap = Number(content.mv);
        console.log(`  ✅ [NaverHTML-ItemContent] Found embedded data`);
      } catch (e) {
        console.log(`  ⚠️ [NaverHTML] ItemContent parse failed: ${e.message}`);
      }
    }

    // 模式2: 搜索 no_today 类 (当前价)
    if (!result.price) {
      m = html.match(/class="no_today"[^>]*>[\s\S]*?<span[\s\S]*?>([,\d]+)</s);
      if (!m) m = html.match(/no_today.*?(\d[\d,]*)\s*</s);
      if (m) {
        result.price = parseInt(m[1].replace(/,/g, ''));
        console.log(`  ✅ [NaverHTML-no_today] price=${result.price}`);
      }
    }

    // 模式3: blind class 用于当前价
    if (!result.price) {
      m = html.match(/<span class="blind">현재가<\/span>\s*([\d,]+)/s);
      if (m) {
        result.price = parseInt(m[1].replace(/,/g, ''));
      }
    }

    // 模式4: 提取涨跌幅
    if (!result.changePercent) {
      m = html.match(/<span class="blind">등락률<\/span>\s*([+-]?[\d.]+%?)/s);
      if (m) {
        result.changePercent = m[1];
      }
    }

    // 模式5: 提取 PER (搜索表格中的PER行)
    if (!result.per) {
      m = html.match(/PER[^<]*<td[^>]*>(\d+\.?\d*)/s);
      if (!m) m = html.match(/PER\s*\(배\)[^0-]*(\d+\.?\d*)/s);
      if (m) result.per = m[1];
    }

    // 模式6: 提取 PBR
    if (!result.pbr) {
      m = html.match(/PBR[^<]*<td[^>]*>(\d+\.?\d*)/s);
      if (!m) m = html.match(/PBR\s*\(배\)[^0-]*(\d+\.?\d*)/s);
      if (m) result.pbr = m[1];
    }

    // 如果至少拿到了价格就认为成功
    if (result.price) {
      result._source = 'naver_html_parse';
      console.log(`  ✅ [NaverHTML] ${code}: price=${result.price}, PER=${result.per || '-'}, PBR=${result.pbr || '-'}`);
      return result;
    }
    
    throw new Error('Could not extract any data from HTML');
  } catch (err) {
    console.error(`  ❌ [NaverHTML] Parse failed for ${code}: ${err.message}`);
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
    for (const key of ['per', 'pbr', 'marketCap', 'foreignRatio']) {
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
  if (su && su._allHistory && su._allHistory.length > 0) {
    dashboardData.chartData = su._allHistory.map(h => ({
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
