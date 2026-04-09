#!/usr/bin/env node
/**
 * 数据抓取脚本 — 从 Naver Finance 抓取韩国游戏股数据
 * 
 * 输出: data/YYYYMMDD.json (每日快照)
 *       data/latest.json  (最新数据软链)
 *       data/dates.json   (可用日期列表)
 * 
 * 用法: node scripts/fetch-data.mjs
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// ============================================================
// 公司配置
// ============================================================
const COMPANIES = [
  { code: '391740', name: 'Shift Up',   nameKr: '시프트업',    color: '#ff6b9d' },
  { code: '042700', name: 'Nexon',      nameKr: '넥슨게임즈',   color: '#22c55e' },
  { code: '251270', name: 'Netmarble',  nameKr: '넷마블',        color: '#ef4444' },
  { code: '036570', name: 'NCSoft',     nameKr: '엔씨소프트',    color: '#3b82f6' },
  { code: '259960', name: 'Krafton',    nameKr: '크래프톤',     color: '#f59e0b' },
  { code: '263750', name: 'Pearl Abyss',nameKr: '펄어비스',     color: '#ec4899' },
];

// ============================================================
// 工具函数
// ============================================================
function getYesterday() {
  const d = new Date();
  // KST = UTC+9, 如果 UTC 时间还没到当天 KST 收盘，则取前一天
  const utcH = d.getUTCHours();
  if (utcH < 8) d.setUTCDate(d.getUTCDate() - 1); // 08 UTC = 17 KST，保守取值
  // 跳过周末
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2); // 日 → 周五
  if (day === 6) d.setUTCDate(d.getUTCDate() - 1); // 六 → 周五
  return d;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function fmtDateDisplay(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatNumber(n) {
  if (!n && n !== 0) return '-';
  return Number(n).toLocaleString('en-US');
}

function formatPrice(p) {
  if (!p) return '-';
  return Math.round(Number(p)).toLocaleString('en-US');
}

function formatWon(n) {
  if (!n) return '-';
  const num = Number(n);
  if (num >= 100000000) {
    return `≈ ${(num / 100000000).toFixed(1)}조원`;
  }
  return `≈ ${Math.round(num / 10000).toLocaleString()}억 ₩`;
}

function changeClass(change) {
  const c = parseFloat(change);
  if (c > 0) return 'up';
  if (c < 0) return 'down';
  return 'neutral';
}

function changeIcon(change) {
  const c = parseFloat(change);
  if (c > 0) return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>';
  if (c < 0) return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M7 7l5 5 5-5M7 17l5-5 5-5"/></svg>';
  return '';
}

// ============================================================
// Naver Finance 数据抓取
// ============================================================

/**
 * 从 Naver Finance 获取股票基本数据（JSONP方式）
 */
async function fetchNaverStock(code) {
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${code}`;
    console.log(`  📡 Fetching Naver Finance: ${code}`);
    
    // 使用 fetch + HTML 解析获取数据
    // Naver Finance 的主要数据通过内嵌的 JSON 变量提供
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // 解析关键数据字段
    const data = parseNaverHtml(html);
    data.code = code;
    data.fetchedAt = new Date().toISOString();
    return data;
  } catch (err) {
    console.error(`  ❌ Failed to fetch ${code}: ${err.message}`);
    return null;
  }
}

/**
 * 解析 Naver Finance HTML 页面提取股票数据
 */
function parseNaverHtml(html) {
  const result = {};

  // 辅助函数：用正则提取 _enc_param 中嵌入的 JSON 数据
  const extractJsonVar = (name) => {
    const patterns = [
      new RegExp(`${name}\\s*=\\s*(\\{[^;]+\\})`, 's'),
      new RegExp(`"${name}"\\s*:\\s*({[^}]+})`, 's'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        try { return JSON.parse(m[1].replace(/'/g, '"')); } catch {}
      }
    }
    return null;
  };

  // 方法2: 用正则从 HTML 表格中提取
  const extractTableValue = (label) => {
    // Naver Finance 使用 <td class="label">标签</td><td>值</td> 格式
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `<td[^>]*class=["']?label["']?[^>]*>[^<]*${escaped}[^<]*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
      'i'
    );
    const m = html.match(pattern);
    if (m) return cleanText(m[1]);

    // 备用模式
    const pattern2 = new RegExp(
      `<th[^>]*>${escaped}</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
      'i'
    );
    const m2 = html.match(pattern2);
    if (m2) return cleanText(m2[1]);
    return null;
  };

  const extractTodayTable = () => {
    // 今日行情表格中的数据
    const data = {};
    
    // 收盘价
    const pricePattern = /<dd[^>]*>([\d,]+)/;
    const pm = html.match(pricePattern);
    if (pm) data.price = pm[1].replace(/,/g, '');

    // 前日收盘
    const yesterdayPattern = /<td class="[^"]*"[^>]*>전일종가<\/td>\s*<td[^>]*>([\d,]+)/;
    const ym = html.match(yesterdayPattern);
    if (ym) data.yesterdayClose = ym[1].replace(/,/g, '');

    // 涨跌额
    const changePattern = /<span[^>]*id=["']?_upDown["']?[^>]*>([+-]?[\d,]+)/;
    const cm = html.match(changePattern);
    if (cm) data.change = cm[1].replace(/,/g, '');

    // 涨跌幅%
    const changeRatePattern = /<span[^>]*id=["']?_rate["']?[^>]*>([+-]?[\d.]+)/;
    const crm = html.match(changeRatePattern);
    if (crm) data.changePercent = crm[1];

    // 最高/最低
    const highPattern = /<td[^>]*>고가<\/td>\s*<td[^>]*>([\d,]+)/;
    const hm = html.match(highPattern);
    if (hm) data.high = hm[1].replace(/,/g, '');

    const lowPattern = /<td[^>]*>저가<\/td>\s*<td[^>]*>([\d,]+)/;
    const lm = html.match(lowPattern);
    if (lm) data.low = lm[1].replace(/,/g, '');

    return data;
  };

  const cleanText = (s) => {
    if (!s) return '';
    return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  };

  // 提取今日行情
  const todayData = extractTodayTable();
  Object.assign(result, todayData);

  // 提取估值指标 (PER, PBR)
  result.per = extractTableValue('PER(배)');
  result.pbr = extractTableValue('PBR(배)');
  
  // 提取市值
  result.marketCap = extractTableValue('시가총액(억)');
  
  // 外资持股比
  result.foreignRatio = extractTableValue('외국인지분율');

  // 尝试从内嵌JSON获取更多数据
  const itemContent = extractJsonVar('_itemContent') || {};
  if (itemContent.price) result.price = itemContent.price;

  return result;
}

/**
 * 获取月度历史数据（用于图表）
 * 使用 Naver Finance 的 JSONP 接口
 */
async function fetchMonthlyHistory(code, yearMonth) {
  try {
    const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=30&requestType=1`;
    console.log(`  📈 Fetching monthly history: ${code}`);
    
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': `https://finance.naver.com/item/sise.naver?code=${code}`,
      },
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    
    // 返回格式: [["日期", "开盘", "最高", "最低", "收盘", "成交量"], ...]
    // 日期格式: 20260401
    const lines = text.trim().split('\n');
    const data = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Array.isArray(row)) {
          for (let i = 1; i < row.length; i++) { // 跳过表头
            const [date, open, high, low, close, volume] = row[i];
            data.push({ date, close: parseInt(close), volume: parseInt(volume || 0) });
          }
        }
      } catch {}
    }
    return data;
  } catch (err) {
    console.error(`  ❌ History fetch failed for ${code}: ${err.message}`);
    return [];
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('='.repeat(50));
  console.log('🎮 韩国游戏股价看板 — 数据抓取脚本');
  console.log('='.repeat(50));

  const targetDate = getYesterday();
  const dateStr = formatDate(targetDate);
  const dateStrDisplay = fmtDateDisplay(targetDate);

  console.log(`\n📅 目标日期: ${dateStr} (${dateStrDisplay})`);
  
  // 确保数据目录存在
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // 并行抓取所有公司数据
  console.log('\n📡 正在抓取 Naver Finance 数据...\n');
  const stockResults = await Promise.all(
    COMPANIES.map(async (comp) => {
      const data = await fetchNaverStock(comp.code);
      if (data) {
        data.name = comp.name;
        data.nameKr = comp.nameKr;
        data.color = comp.color;
      }
      return data;
    })
  );

  // 构建 Shift Up 核心数据
  const su = stockResults.find(r => r?.code === '391740');

  // 构建完整看板数据包
  const dashboardData = {
    meta: {
      date: dateStr,
      dateDisplay: `${targetDate.getMonth() + 1}月（截至${targetDate.getDate()}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance',
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
      marketCap: su.marketCap ? formatWon((parseFloat(su.marketCap.replace(/,/g, '')) * 100000000).toString()) : '-',
      foreignRatio: su.foreignRatio || '-',
    } : null,

    companies: stockResults.filter(r => r && r.code !== '391740').map(r => ({
      code: r.code,
      name: r.name,
      nameKr: r.nameKr,
      color: r.color,
      price: formatPrice(r.price),
      change: r.change ? `${changeClass(r.change) === 'up' ? '+' : ''}${r.changePercent}` : '-',
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
  const history = await fetchMonthlyHistory('391740', ym);
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
  
  console.log(`\n🎉 完成! 共更新 ${COMPANIES.length} 家公司数据`);
  console.log(`   Shift Up 价格: ₩${dashboardData.shiftUp?.price || 'N/A'}, PER: ${dashboardData.shiftUp?.per || 'N/A'}`);
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
    dates.sort().reverse(); // 最新的在前面
    // 只保留最近60个交易日
    dates = dates.slice(0, 60);
  }

  writeFileSync(datesFile, JSON.stringify({ dates }, null, 2), 'utf-8');
  console.log(`✅ 日期列表已更新: ${dates.length} 个存档`);
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
