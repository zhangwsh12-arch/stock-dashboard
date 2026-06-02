#!/usr/bin/env node
// ============================================================
// 企业微信群机器人推送 - 韩国游戏股价看板
// 用途：每日数据更新后，将"股价概况"推送到企业微信群
// 触发方式：GitHub Actions workflow 中调用
// 环境变量：WECOM_WEBHOOK_URL（群机器人 Webhook 地址）
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_PATH = join(import.meta.dirname || '.', '..', 'data', 'latest.json');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://nebula.kr.stock-dashboard.com';

// ====== 读取数据 ======
let data;
try {
  data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
} catch (e) {
  console.error('[notify] 无法读取 latest.json:', e.message);
  process.exit(1);
}

if (!data?.meta) {
  console.error('[notify] latest.json 结构异常，缺少 meta 字段');
  process.exit(1);
}

// ====== 校验数据日期 ======
function getExpectedTradingDay() {
  const now = new Date();
  // 精确转换为韩国时间（UTC+9），避免 koreaHour 溢出 24 的 bug
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  
  let targetYear  = kstTime.getUTCFullYear();
  let targetMonth = kstTime.getUTCMonth();
  let targetDay   = kstTime.getUTCDate();
  const kstHour   = kstTime.getUTCHours();
  const kstMin    = kstTime.getUTCMinutes();
  
  if (kstHour < 15 || (kstHour === 15 && kstMin < 30)) {
    targetDay -= 1;
  }
  
  const d = new Date(Date.UTC(targetYear, targetMonth, targetDay));

  const KRX_HOLIDAYS = [
    '20260101', '20260216', '20260217', '20260218',
    '20260302', '20260501', '20260505', '20260525',
    '20260817', '20260924', '20260925', '20261005',
    '20261009', '20261225'
  ];

  while (true) {
    const day = d.getUTCDay();
    if (day === 0) { d.setUTCDate(d.getUTCDate() - 2); continue; }
    if (day === 6) { d.setUTCDate(d.getUTCDate() - 1); continue; }
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dayStr = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = `${y}${m}${dayStr}`;
    if (KRX_HOLIDAYS.includes(dateStr)) { d.setUTCDate(d.getUTCDate() - 1); continue; }
    break;
  }
  return d;
}

const expectedDate = getExpectedTradingDay();
const expectedDateStr = `${expectedDate.getUTCFullYear()}${String(expectedDate.getUTCMonth() + 1).padStart(2, '0')}${String(expectedDate.getUTCDate()).padStart(2, '0')}`;

if (data.meta?.date !== expectedDateStr) {
  console.warn(`[notify] ⚠️ 数据日期异常: latest.json 记录为 ${data.meta?.date}，预期最近交易日为 ${expectedDateStr}`);
  console.warn(`[notify] 可能原因: 数据抓取失败或使用了旧数据，推送内容可能不准确`);
}

// ====== 构建消息 ======
const meta = data.meta;
const su = data.shiftUp;
const companies = data.companies || [];

// 统一股票列表
const allStocks = [];
if (su) {
  allStocks.push({
    name: su.name,
    price: su.price,
    changePercent: su.changePercent,
    changeClass: su.changeClass,
  });
}
companies.forEach(c => {
  allStocks.push({
    name: c.name,
    price: c.price,
    changePercent: c.change || '0%',
    changeClass: c.changeClass,
  });
});

// 解析涨跌幅数值用于排序
function parsePct(str) {
  const m = String(str).match(/([+-]?[\d.]+)%/);
  return m ? parseFloat(m[1]) : 0;
}

// 按涨跌幅排序（从高到低）
const sorted = [...allStocks].sort((a, b) => parsePct(b.changePercent) - parsePct(a.changePercent));

// 统计涨跌家数
let upCount = 0, downCount = 0, neutralCount = 0;
sorted.forEach(s => {
  if (s.changeClass === 'up') upCount++;
  else if (s.changeClass === 'down') downCount++;
  else neutralCount++;
});

// 格式化涨跌箭头和颜色
function formatChange(cp, cc) {
  const val = parsePct(cp);
  const sign = val >= 0 ? '+' : '';
  const arrow = cc === 'up' ? '\u2191' : cc === 'down' ? '\u2193' : '\u2192';
  return `${arrow} ${sign}${val.toFixed(2)}%`;
}

// 构建行情行
const stockLines = sorted.map(s => {
  const arrowIcon = s.changeClass === 'up' ? '' : s.changeClass === 'down' ? '' : '\u25CB';
  return `${arrowIcon} **${s.name}**  \u20A9${s.price}  ${formatChange(s.changePercent, s.changeClass)}`;
});

// 市场情绪判断
let sentiment, sentimentEmoji;
const total = sorted.length;
if (upCount > downCount && upCount > total / 2) {
  sentiment = '整体偏强，多数公司上涨';
  sentimentEmoji = '';
} else if (downCount > upCount && downCount > total / 2) {
  sentiment = '承压调整，多数公司下跌';
  sentimentEmoji = '';
} else {
  sentiment = '涨跌互现，无明显方向';
  sentimentEmoji = '';
}

// 日期显示
let displayDate = meta.dateDisplay || meta.date || '';
// 提取纯日期部分
const dateMatch = displayDate.match(/(\d+[月日]+)/);
if (!dateMatch && /^\d{8}$/.test(meta.date)) {
  const m = parseInt(meta.date.slice(4, 6), 10);
  const d = parseInt(meta.date.slice(6), 10);
  displayDate = `${m}/${d}`;
}

// ====== 组装 Markdown 消息（企业微信支持 subset of Markdown）======
const message = {
  msgtype: 'markdown',
  markdown: {
    content: `### \ud83d\udcca <font color="info">韩国游戏股价看板</font>

> ${displayDate}收盘数据 | 共 ${total} 家 \u00b7 <font color="info">${upCount}\u6DA8</font> / <font color="warning">${downCount}\u8DCC</font> / ${neutralCount}\u5E73

${stockLines.join('\n')}

---

${sentimentEmoji} **市场小结**: ${sentiment}

[\u{1F517} 查看完整看板\u2192](${DASHBOARD_URL})`,
  },
};

// ====== 发送到企业微信（支持多个 Webhook，逗号分隔）======
const webhookStr = process.env.WECOM_WEBHOOK_URL || '';
const webhookUrls = webhookStr.split(',').map(u => u.trim()).filter(u => u.startsWith('https://qyapi.weixin.qq.com'));

if (webhookUrls.length === 0) {
  console.error('[notify] WECOM_WEBHOOK_URL 未设置或格式不正确');
  console.log('[notify] 消息内容预览:');
  console.log(JSON.stringify(message.markdown.content, null, 2));
  process.exit(0); // 非致命错误，不阻断 workflow
}

let successCount = 0;
for (const url of webhookUrls) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    const result = await res.json();

    if (result.errcode === 0) {
      successCount++;
      console.log(`[notify] 推送成功! (${displayDate}, ${upCount}涨/${downCount}跌/${neutralCount}平) [${successCount}/${webhookUrls.length}]`);
    } else {
      console.error(`[notify] 推送失败: errcode=${result.errcode}, errmsg=${result.errmsg}`);
    }
  } catch (e) {
    console.error(`[notify] 发送请求失败:`, e.message);
  }
}

if (successCount === 0) process.exit(1);
console.log(`[notify] 全部完成: ${successCount}/${webhookUrls.length} 个群推送成功`);
