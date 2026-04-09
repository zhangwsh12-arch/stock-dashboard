#!/usr/bin/env node
/**
 * 数据抓取脚本 v2 — 使用 Naver Finance 内部 API 获取韩国游戏股数据
 * 
 * 数据来源:
 *   1. finance.naver.com/item/info.naver (官方内部API, 返回完整JSON)
 *   2. fchart.stock.naver.com (K线历史数据)
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
  { code: '391740', name: 'Shift Up',     nameKr: '시프트업',    color: '#ff6b9d' },
  { code: '042700', name: 'Nexon',         nameKr: '넥슨게임즈',   color: '#22c55e' },
  { code: '251270', name: 'Netmarble',     nameKr: '넷마블',        color: '#ef4444' },
  { code: '036570', name: 'NCSoft',        nameKr: '엔씨소프트',    color: '#3b82f6' },
  { code: '259960', name: 'Krafton',       nameKr: '크래프톤',     color: '#f59e0b' },
  { code: '263750', name: 'Pearl Abyss',   nameKr: '펄어비스',     color: '#ec4899' },
];

// ============================================================
// 工具函数
// ============================================================
function getYesterday() {
  const d = new Date();
  const utcH = d.getUTCHours();
  if (utcH < 8) d.setUTCDate(d.getUTCDate() - 1);
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
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
  if (num >= 100000000) return `≈ ${(num / 100000000).toFixed(1)}조원`;
  if (num >= 10000) return `≈ ${Math.round(num / 10000).toLocaleString()}억 ₩`;
  return `≈ ${Math.round(num).toLocaleString()}₩`;
}

function changeClass(change) {
  const c = parseFloat(change);
  if (c > 0) return 'up';
  if (c < 0) return 'down';
  return 'neutral';
}

// ============================================================
// Naver Finance API 数据抓取 (v2 — 使用内部JSON API)
// ============================================================

/**
 * 方法1: 使用 Naver Finance itemInfo API (最可靠，返回完整JSON)
 * URL格式: https://finance.naver.com/item/info.naver?code=XXXXXX
 */
async function fetchViaItemInfo(code) {
  try {
    const url = `https://finance.naver.com/item/info.naver?code=${code}`;
    console.log(`  📡 [API] Fetching itemInfo: ${code}`);
    
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': `https://finance.naver.com/item/main.naver?code=${code}`,
      },
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    
    // itemInfo 返回的是 JavaScript 变量赋值格式
    // 需要提取其中的 JSON 对象
    // 格式类似: _itemInfo = {"cd":"391740","nm":"시프트업",...};
    const match = text.match(/_itemInfo\s*=\s*(\{[\s\S]+?\});?\s*<\/script>/i);
    if (!match) throw new Error('No _itemInfo found in response');
    
    const jsonStr = match[1].replace(/'/g, '"');
    const data = JSON.parse(jsonStr);
    
    return data;
  } catch (err) {
    console.error(`  ❌ [API] itemInfo failed for ${code}: ${err.message}`);
    return null;
  }
}

/**
 * 方法2 (备用): 使用 main 页面 + 正则解析 HTML
 */
async function fetchViaHtmlParse(code) {
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${code}`;
    console.log(`  📡 [HTML] Fetching main page: ${code}`);
    
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    
    const result = {};
    
    // 尝试从内嵌的 JavaScript 变量中提取数据
    // 模式1: _itemContent 变量
    let m = html.match(/_itemContent\s*[:=]\s*(\{[^}]+\})/s);
    if (m) {
      try {
        const content = JSON.parse(m[1].replace(/'/g, '"'));
        if (content.price) result.price = content.price;
      } catch {}
    }
    
    // 模式2: 直接从 HTML 中提取数字
    // 收盘价 - 在 <dd> 标签中的大数字
    if (!result.price) {
      m = html.match(/<dd[^>]*>\s*([\d,]+)\s*<\/dd>/);
      if (m) result.price = m[1].replace(/,/g, '');
    }
    
    // 前日收盘
    m = html.match(/전일종가<\/(?:td|th)[^>]*>.*?<(?:td|th)[^>]*>([\d,]+)/s);
    if (m) result.yesterdayClose = m[1].replace(/,/g, '');
    
    // 涨跌额 (_upDown)
    m = html.match(/id="_upDown"[^>]*>([+-]?[\d,]+)/);
    if (m) result.change = m[1].replace(/,/g, '');
    
    // 涨跌幅% (_rate)
    m = html.match(/id="_rate"[^>]*>([+-]?[\d.]+)/);
    if (m) result.changePercent = m[1];
    
    // 最高价
    m = html.match(/고가<\/(?:td|th)[^>]*>.*?<(?:td|th)[^>]*>([\d,]+)/s);
    if (m) result.high = m[1].replace(/,/g, '');
    
    // 最低价
    m = html.match(/저가<\/(?:td|th)[^>]*>.*?<(?:td|th)[^>]*>([\d,]+)/s);
    if (m) result.low = m[1].replace(/,/g, '');
    
    // PER
    m = html.match(/PER\s*\([^)]*\)[^<]*(?:<[^>]+>)*\s*(\d+\.?\d*)/);
    if (m) result.per = m[1];
    
    // PBR
    m = html.match(/PBR\s*\([^)]*\)[^<]*(?:<[^>]+>)*\s*(\d+\.?\d*)/);
    if (m) result.pbr = m[1];
    
    // 如果有 price 字段就返回
    if (result.price) return result;
    return null;
  } catch (err) {
    console.error(`  ❌ [HTML] Parse failed for ${code}: ${err.message}`);
    return null;
  }
}

/**
 * 统一的股票数据获取入口
 */
async function fetchStockData(code) {
  // 优先尝试方法1 (itemInfo API)
  let apiData = await fetchViaItemInfo(code);
  
  if (apiData && apiData.cv) {
    // itemInfo API 返回的数据字段映射:
    // cv = 当前价格 (current value), nv = 昨收, hv = 高价, lv = 低价
    // cr = 涨跌额, ra = 涨跌幅%, per = PER, pbr = PBR, mv = 市值, fr = 外资持股比
    return {
      price: apiData.cv,
      yesterdayClose: apiData.nv,
      high: apiData.hv,
      low: apiData.lv,
      change: apiData.cr,
      changePercent: apiData.ra,
      per: apiData.per,
      pbr: apiData.pbr,
      marketCap: apiData.mv,
      foreignRatio: apiData.fr,
      _source: 'itemInfo_api',
    };
  }

  // 回退到方法2 (HTML 解析)
  const htmlData = await fetchViaHtmlParse(code);
  if (htmlData) {
    return { ...htmlData, _source: 'html_parse' };
  }
  
  return null;
}

/**
 * 获取月度历史数据（用于走势图）
 */
async function fetchMonthlyHistory(code) {
  try {
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=30&requestType=1`;
    console.log(`  📈 [Chart] Fetching history: ${code}`);
    
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': `https://finance.naver.com/item/sise.naver?code=${code}`,
      },
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    
    const lines = text.trim().split('\n');
    const data = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Array.isArray(row)) {
          for (let i = 1; i < row.length; i++) {
            const [date, , high, low, close, volume] = row[i];
            data.push({ date, close: parseInt(close), high: parseInt(high), low: parseInt(low), volume: parseInt(volume || 0) });
          }
        }
      } catch {}
    }
    return data;
  } catch (err) {
    console.error(`  ❌ [Chart] History failed for ${code}: ${err.message}`);
    return [];
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('🎮 韩国游戏股价看板 — 数据抓取 v2');
  console.log(`🕒 运行时间: ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  const targetDate = getYesterday();
  const dateStr = formatDate(targetDate);

  console.log(`\n📅 目标日期: ${dateStr} (${targetDate.getMonth() + 1}月${targetDate.getDate()}日)`);
  
  // 确保数据目录存在
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 并行抓取所有公司数据
  console.log('\n📡 正在抓取 Naver Finance 数据...\n');
  const stockResults = await Promise.all(
    COMPANIES.map(async (comp) => {
      console.log(`\n  ┌─ ${comp.name} (${comp.code})`);
      const data = await fetchStockData(comp.code);
      if (data) {
        data.name = comp.name;
        data.nameKr = comp.nameKr;
        data.color = comp.color;
        console.log(`  │ ✅ 价格: ₩${formatPrice(data.price)}, PER: ${data.per || '-'}, 来源: ${data._source}`);
      } else {
        console.log(`  │ ❌ 抓取失败`);
      }
      console.log(`  └─`);
      return data;
    })
  );

  // 检查是否所有公司都获取成功
  const successCount = stockResults.filter(r => r !== null).length;
  console.log(`\n📊 成功: ${successCount}/${COMPANIES.length} 家公司`);
  
  if (successCount === 0) {
    console.error('\n❌ 所有公司数据获取失败，退出！');
    process.exit(1);
  }

  // 构建 Shift Up 核心数据
  const su = stockResults.find(r => r?.code === '391740') || stockResults.find(r => r !== null);

  // 构建完整看板数据包
  const dashboardData = {
    meta: {
      date: dateStr,
      dateDisplay: `${targetDate.getMonth() + 1}月（截至${targetDate.getDate()}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance',
      updateCount: successCount,
    },
    shiftUp: su ? {
      code: su.code,
      name: su.name,
      nameKr: su.nameKr,
      color: su.color,
      price: formatPrice(su.price),
      previousClose: formatPrice(su.yesterdayClose),
      high: formatPrice(su.high),
      low: formatPrice(su.low),
      change: su.change ? Number(su.change).toLocaleString() : '-',
      changePercent: su.changePercent || '-',
      changeClass: changeClass(su.change),
      per: su.per || '-',
      pbr: su.pbr || '-',
      marketCap: formatWon(su.marketCap),
      foreignRatio: su.foreignRatio ? `${su.foreignRatio}%` : '-',
    } : null,

    companies: stockResults.filter(r => r && r.code !== '391740').map(r => ({
      code: r.code,
      name: r.name,
      nameKr: r.nameKr,
      color: r.color,
      price: formatPrice(r.price),
      change: r.changePercent ? `${changeClass(r.change) === 'up' ? '+' : ''}${r.changePercent}` : '-',
      changeClass: changeClass(r.change),
      per: r.per || '-',
    })).sort((a, b) => (parseFloat(a.per) || 999) - (parseFloat(b.per) || 999)),

    // PER 对比数据（用于条形图）
    perComparison: stockResults.filter(r => r && r.per).map(r => ({
      code: r.code,
      name: r.name,
      color: r.color,
      price: formatPrice(r.price),
      per: parseFloat(r.per),
      perRaw: r.per,
    })).sort((a, b) => a.per - b.per),

    // 月度走势数据（Shift Up）
    chartData: [],
  };

  // 获取 Shift Up 月度走势
  const ym = `${targetDate.getFullYear()}${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
  const history = await fetchMonthlyHistory('391740');
  if (history.length > 0) {
    dashboardData.chartData = history.map(h => ({
      date: h.date,
      label: `${parseInt(h.date.slice(4,6))}/${parseInt(h.date.slice(6,8))}`,
      price: h.close,
    }));
  }

  // 写入每日快照文件
  const outFile = join(DATA_DIR, `${dateStr}.json`);
  writeFileSync(outFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`\n✅ 数据已保存: ${outFile}`);

  // 更新 latest.json
  const latestFile = join(DATA_DIR, 'latest.json');
  writeFileSync(latestFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`✅ 最新数据已更新: latest.json`);

  // 更新 dates.json（可用日期列表）
  updateDatesList(dateStr);
  
  console.log(`\n🎉 完成! 共更新 ${successCount}/${COMPANIES.length} 家公司`);
  if (dashboardData.shiftUp) {
    console.log(`   Shift Up 价格: ₩${dashboardData.shiftUp.price}, PER: ${dashboardData.shiftUp.per}, PBR: ${dashboardData.shiftUp.pbr}`);
  }
  console.log(`   其他公司: ${dashboardData.companies.map(c => `${c.name}:${c.price}`).join(', ')}`);
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
