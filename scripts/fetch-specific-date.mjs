#!/usr/bin/env node
/**
 * 补抓指定日期的股价数据
 * 用法: node scripts/fetch-specific-date.mjs YYYYMMDD
 * 示例: node scripts/fetch-specific-date.mjs 20260605
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const COMPANIES = [
  { code: '462870', name: 'Shift Up',    yahoo: '462870.KQ' },
  { code: '225570', name: 'Nexon Games', yahoo: '225570.KS' },
  { code: '251270', name: 'Netmarble',   yahoo: '251270.KS' },
  { code: '036570', name: 'NC',         yahoo: '036570.KS' },
  { code: '259960', name: 'Krafton',     yahoo: '259960.KQ' },
  { code: '263750', name: 'Pearl Abyss', yahoo: '263750.KS' },
];

const KRX_HOLIDAYS = new Set([
  '20260101','20260216','20260217','20260218',
  '20260302','20260501','20260505','20260525',
  '20260603','20260717','20260817',
  '20260924','20260925','20261005',
  '20261009','20261225','20261231'
]);

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    ...options.headers,
  };
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, headers: defaultHeaders });
      if (resp.ok) return resp;
      if (resp.status !== 429 && resp.status !== 503 && resp.status !== 502) {
        throw new Error(`HTTP ${resp.status}`);
      }
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function fetchNaverChartForDate(code, targetDateStr) {
  const url = `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&timeframe=day&count=80&requestType=0`;
  const resp = await fetchWithRetry(url);
  const buf = await resp.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf).trim();
  const startIdx = text.indexOf('[');
  if (startIdx > 0) text = text.substring(startIdx);
  text = text.replace(/'/g, '"');
  const data = JSON.parse(text);
  
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
      });
    }
  }
  
  // 找目标日期的数据
  const targetEntry = allData.find(d => d.date === targetDateStr);
  if (!targetEntry) throw new Error(`目标日期 ${targetDateStr} 无数据`);
  
  // 找前一个交易日数据（用于算涨跌）
  const idx = allData.indexOf(targetEntry);
  const prevEntry = idx > 0 ? allData[idx - 1] : null;
  
  const change = prevEntry ? targetEntry.close - prevEntry.close : 0;
  
  console.log(`  ✅ ${code}: ${targetDateStr} 收盘=${targetEntry.close.toLocaleString()}, 涨跌=${change}`);
  
  return {
    date: targetEntry.date,
    price: targetEntry.close,
    yesterdayClose: prevEntry ? prevEntry.close : targetEntry.close,
    change,
    changePercent: prevEntry ? ((change / prevEntry.close) * 100).toFixed(2) : '0.00',
    open: targetEntry.open,
    high: targetEntry.high,
    low: targetEntry.low,
    volume: targetEntry.volume,
    _allHistory: allData,
  };
}

async function fetchNaverHtml(code) {
  try {
    const url = `https://finance.naver.com/item/main.naver?code=${code}`;
    const resp = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://finance.naver.com/' },
    });
    const buf = await resp.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(buf);
    
    const result = {};
    
    // PER
    const perMatch = html.match(/<span>PER\(%\)<\/span><\/th>\s*<td>([\d.\-&;]+)<\/td>/);
    if (perMatch) {
      let val = perMatch[1].replace(/&nbsp;/g, '').trim();
      if (val && val !== '-') {
        const num = parseFloat(val);
        result.per = (num < 0 || isNaN(num)) ? null : val;
      }
    }
    
    // PBR
    const pbrMatch = html.match(/id="_pbr">\s*([\d.\-]+)\s*</);
    if (pbrMatch) result.pbr = pbrMatch[1];
    
    // MarketCap
    const capMatch = html.match(/시가총액\(억\)[\s\S]*?<\/th>\s*<td[^>]*>\s*([\d,]+)\s*<\/td>/s);
    if (capMatch) result.marketCap = parseInt(capMatch[1].replace(/,/g, '')) * 100000000;
    
    if (Object.keys(result).length > 0) {
      console.log(`  ✅ [HTML] ${code}: PER=${result.per || '-'}, PBR=${result.pbr || '-'}`);
    }
    return result;
  } catch (e) {
    return {};
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node scripts/fetch-specific-date.mjs YYYYMMDD');
    process.exit(1);
  }
  
  const targetDateStr = args[0];
  if (!/^\d{8}$/.test(targetDateStr)) {
    console.error('日期格式错误，需要 YYYYMMDD');
    process.exit(1);
  }
  
  // 检查是否是休市日
  if (KRX_HOLIDAYS.has(targetDateStr)) {
    console.error(`❌ ${targetDateStr} 是KRX休市日，跳过`);
    process.exit(1);
  }
  
  const y = parseInt(targetDateStr.slice(0,4));
  const m = parseInt(targetDateStr.slice(4,6)) - 1;
  const d = parseInt(targetDateStr.slice(6,8));
  const targetDate = new Date(Date.UTC(y, m, d));
  
  console.log(`\n🎯 补抓日期: ${targetDateStr} (${y}年${m+1}月${d}日)\n`);
  
  // 检查是否已存在
  const outFile = join(DATA_DIR, `${targetDateStr}.json`);
  if (existsSync(outFile)) {
    console.log(`⚠️  ${targetDateStr}.json 已存在，将覆盖`);
  }
  
  // 并行抓取所有公司
  const stockResults = await Promise.all(
    COMPANIES.map(async (comp) => {
      console.log(`\n  ┌─ ${comp.name} (${comp.code})`);
      try {
        const chartData = await fetchNaverChartForDate(comp.code, targetDateStr);
        
        // 补充 PER/PBR
        const htmlData = await fetchNaverHtml(comp.code);
        if (htmlData.per && !chartData.per) chartData.per = htmlData.per;
        if (htmlData.pbr && !chartData.pbr) chartData.pbr = htmlData.pbr;
        if (htmlData.marketCap && !chartData.marketCap) chartData.marketCap = htmlData.marketCap;
        
        chartData.code = comp.code;
        chartData.name = comp.name;
        chartData.color = comp.color || '#666';
        console.log(`  └─ ✅`);
        return chartData;
      } catch (err) {
        console.log(`  └─ ❌ ${err.message}`);
        return null;
      }
    })
  );
  
  const successCount = stockResults.filter(r => r !== null).length;
  console.log(`\n📊 成功: ${successCount}/${COMPANIES.length} 家公司`);
  
  if (successCount === 0) {
    console.error('❌ 所有公司数据获取失败！');
    process.exit(1);
  }
  
  // 构建 dashboardData
  const realShiftUp = stockResults.find(r => r?.code === '462870');
  
  const dashboardData = {
    meta: {
      date: targetDateStr,
      dateDisplay: `${targetDate.getUTCMonth() + 1}月（截至${targetDate.getUTCDate()}日）`,
      fetchedAt: new Date().toISOString(),
      source: 'Naver Finance / Backfill Script',
      updateCount: successCount,
    },
    shiftUp: realShiftUp ? {
      code: '462870',
      name: 'Shift Up',
      color: '#ff6b9d',
      price: Math.round(realShiftUp.price).toLocaleString('en-US'),
      previousClose: Math.round(realShiftUp.yesterdayClose).toLocaleString('en-US'),
      high: Math.round(realShiftUp.high || realShiftUp.price).toLocaleString('en-US'),
      low: Math.round(realShiftUp.low || realShiftUp.price).toLocaleString('en-US'),
      change: realShiftUp.change ? Number(realShiftUp.change).toLocaleString() : '-',
      changePercent: realShiftUp.changePercent
        ? (parseFloat(realShiftUp.changePercent) > 0 ? '+' : '') + realShiftUp.changePercent + '%'
        : '-',
      changeClass: realShiftUp.change >= 0 ? 'up' : 'down',
      per: (realShiftUp.per && parseFloat(realShiftUp.per) > 0) ? realShiftUp.per : 'N/A',
      pbr: realShiftUp.pbr || '-',
      marketCap: realShiftUp.marketCap ? formatWon(realShiftUp.marketCap) : '-',
      _allHistory: realShiftUp._allHistory || [],
    } : null,
    companies: stockResults
      .filter(r => r && r.code !== '462870')
      .map(r => ({
        code: r.code,
        name: r.name,
        color: r.color,
        price: Math.round(r.price).toLocaleString('en-US'),
        change: r.changePercent ? `${r.change >= 0 ? '+' : ''}${r.changePercent}%` : '-',
        changeClass: r.change >= 0 ? 'up' : 'down',
        per: (r.per && parseFloat(r.per) > 0) ? r.per : 'N/A',
      }))
      .sort((a, b) => (parseFloat(a.per) || 999) - (parseFloat(b.per) || 999)),
    perComparison: stockResults
      .filter(r => r && r.per && parseFloat(r.per) > 0)
      .map(r => ({
        code: r.code,
        name: r.name,
        color: r.color,
        price: Math.round(r.price).toLocaleString('en-US'),
        per: parseFloat(r.per),
        perRaw: r.per,
      }))
      .sort((a, b) => a.per - b.per),
    chartData: [],
    indices: [],
  };
  
  // chartData
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
  writeFileSync(outFile, JSON.stringify(dashboardData, null, 2), 'utf-8');
  console.log(`\n✅ 数据已保存: ${outFile}`);
  
  // 更新 latest.json（如果目标日期比现有 latest 更新）
  const latestFile = join(DATA_DIR, 'latest.json');
  let shouldUpdateLatest = true;
  if (existsSync(latestFile)) {
    try {
      const latest = JSON.parse(readFileSync(latestFile, 'utf-8'));
      if (latest.meta?.date && latest.meta.date > targetDateStr) {
        shouldUpdateLatest = false;
        console.log(`⏭️  latest.json 日期(${latest.meta.date})比目标日期(${targetDateStr})新，跳过更新`);
      }
    } catch (_) {}
  }
  
  if (shouldUpdateLatest) {
    writeFileSync(join(DATA_DIR, 'latest.json'), JSON.stringify(dashboardData, null, 2), 'utf-8');
    console.log(`✅ latest.json 已更新为 ${targetDateStr}`);
  }
  
  // 更新 content.json 的 compareChart
  updateCompareChart(stockResults, targetDate, targetDateStr);
  
  // 更新 dates.json
  updateDatesList(targetDateStr);
  
  console.log(`\n🎉 ${targetDateStr} 补抓完成!`);
}

function formatWon(n) {
  if (!n || isNaN(n)) return '-';
  const num = Number(n);
  if (num >= 1000000000000) return `${(num / 1000000000000).toFixed(2)}兆元`;
  if (num >= 100000000) return `${(num / 100000000).toFixed(2)}亿元`;
  if (num >= 10000) return `${Math.round(num / 10000).toLocaleString()}亿 ₩`;
  return `≈ ${Math.round(num).toLocaleString()}₩`;
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
  console.log(`✅ 日期列表已更新`);
}

function updateCompareChart(stockResults, targetDate, targetDateStr) {
  const contentFile = join(DATA_DIR, 'content.json');
  if (!existsSync(contentFile)) {
    console.log('⚠️  content.json 不存在，跳过 compareChart 更新');
    return;
  }
  
  let content;
  try {
    content = JSON.parse(readFileSync(contentFile, 'utf-8'));
  } catch (err) {
    console.error(`❌ 读取 content.json 失败: ${err.message}`);
    return;
  }
  
  if (!content.compareChart || !content.compareChart.datasets) {
    console.log('⚠️  content.json 中无 compareChart，跳过');
    return;
  }
  
  const chart = content.compareChart;
  const label = `${targetDate.getUTCMonth() + 1}/${targetDate.getUTCDate()}`;
  
  // 幂等：如果标签已存在则先删除旧数据
  const existingIndex = chart.labels.indexOf(label);
  if (existingIndex !== -1) {
    console.log(`⚠️  ${label} 已存在，将覆盖`);
    chart.labels.splice(existingIndex, 1);
    for (const ds of chart.datasets) {
      ds.data.splice(existingIndex, 1);
    }
  }
  
  // 动态获取当月首个交易日作为基准日
  const compareBaseDate = getFirstTradingDayOfMonth(targetDate.getUTCFullYear(), targetDate.getUTCMonth());
  console.log(`📊 compareChart 基准日: ${compareBaseDate}`);
  
  // 检测是否跨月
  const currentMonthPrefix = `${targetDate.getUTCMonth() + 1}/`;
  const hasCurrentMonthData = chart.labels.some(l => l.startsWith(currentMonthPrefix));
  
  chart.labels.push(label);
  
  const CHART_NAME_MAP = {
    'Shift Up': 'Shift Up',
    'Nexon': 'Nexon Games',
    'Netmarble': 'Netmarble',
    'NC': 'NC',
    'Krafton': 'Krafton',
    'P.Abyss': 'Pearl Abyss',
  };
  
  let updatedCount = 0;
  for (const dataset of chart.datasets) {
    const stockName = CHART_NAME_MAP[dataset.label] || dataset.label;
    const stockResult = stockResults.find(r => r?.name === stockName);
    
    if (!stockResult || !stockResult.price) {
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
    
    // 用 _allHistory 精确计算
    if (stockResult._allHistory && stockResult._allHistory.length > 0) {
      const baseEntry = stockResult._allHistory.find(h => h.date === compareBaseDate);
      const targetEntry = stockResult._allHistory.find(h => h.date === targetDateStr);
      
      if (baseEntry && targetEntry) {
        const basePrice = baseEntry.close;
        const targetPrice = targetEntry.close;
        const cumulative = ((targetPrice - basePrice) / basePrice) * 100;
        const rounded = Math.round(cumulative * 100) / 100;
        dataset.data.push(rounded);
        console.log(`  📊 ${dataset.label}: ${rounded}% (基准₩${basePrice.toLocaleString()} → ₩${targetPrice.toLocaleString()})`);
        updatedCount++;
        continue;
      }
    }
    
    // 回退：沿用上一个值
    const lastVal = dataset.data.length > 0 ? dataset.data[dataset.data.length - 1] : 0;
    dataset.data.push(lastVal);
    console.log(`  📊 ${dataset.label}: 无法精确计算，沿用 ${lastVal}%`);
  }
  
  // 数据长度校验
  const labelsLen = chart.labels.length;
  for (const ds of chart.datasets) {
    if (ds.data.length !== labelsLen) {
      console.warn(`⚠️ ${ds.label} data长度(${ds.data.length})与labels(${labelsLen})不一致，自动修复`);
      while (ds.data.length > labelsLen) ds.data.pop();
      while (ds.data.length < labelsLen) {
        ds.data.push(ds.data.length > 0 ? ds.data[ds.data.length - 1] : 0);
      }
    }
  }
  
  // 更新 meta.updatedAt
  const yyyy = targetDate.getUTCFullYear();
  const mm = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getUTCDate()).padStart(2, '0');
  content.meta.updatedAt = `${yyyy}-${mm}-${dd}`;
  
  writeFileSync(contentFile, JSON.stringify(content, null, 2), 'utf-8');
  console.log(`✅ compareChart 已更新: 新增 ${label}，${updatedCount} 家公司使用精确计算`);
}

function getFirstTradingDayOfMonth(year, month) {
  for (let day = 1; day <= 10; day++) {
    const d = new Date(Date.UTC(year, month, day));
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    const dateStr = formatDate(d);
    if (KRX_HOLIDAYS.has(dateStr)) continue;
    return dateStr;
  }
  return null;
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
