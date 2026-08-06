#!/usr/bin/env node
// ============================================================
// 企业微信群机器人推送 - 韩国游戏股价看板
// 用途：每日数据更新后，将"股价概况"推送到企业微信群
// 触发方式：GitHub Actions / 工蜂 CI workflow 中调用
// 环境变量：
//   WECOM_WEBHOOK_URL - 群机器人 Webhook 地址
//   FORCE_NOTIFY       - 'true' 时忽略每日去重，强制推送
// ============================================================
//
// 每日去重说明：
// GitHub Actions 版本用 actions/cache@v4 做跨 job 的每日去重缓存，
// 工蜂 CI（蓝盾）没有等价的开箱即用缓存插件，因此改为在脚本内部实现：
// 读写 data/.notify-sent-YYYYMMDD 标记文件并随 data/ 一起提交到仓库，
// 下次运行时如果标记文件存在（且日期匹配、非强制推送）则跳过推送。
// 这样无论运行在 GitHub Actions 还是工蜂 CI，逻辑完全一致，不依赖平台特性。

import { readFileSync, existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DATA_PATH = join(import.meta.dirname || '.', '..', 'data', 'latest.json');
const DATA_DIR = join(import.meta.dirname || '.', '..', 'data');
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://nebula.kr.stock-dashboard.com';
const FORCE_NOTIFY = String(process.env.FORCE_NOTIFY || '').toLowerCase() === 'true';

// ====== 每日去重：基于 KST 日期的标记文件 ======
function getTodayKSTStr() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

const todayStr = getTodayKSTStr();
const markerPath = join(DATA_DIR, `.notify-sent-${todayStr}`);

if (existsSync(markerPath) && !FORCE_NOTIFY) {
  console.log(`[notify] ⏭️ 今日 (${todayStr}) 已推送过，跳过（如需强制推送请设置环境变量 FORCE_NOTIFY=true）`);
  process.exit(0);
}
if (existsSync(markerPath) && FORCE_NOTIFY) {
  console.log(`[notify] 🔄 FORCE_NOTIFY=true，忽略去重标记，强制推送`);
}

// 清理往日遗留的标记文件（只保留最近的，避免 data/ 目录堆积垃圾文件）
try {
  for (const f of readdirSync(DATA_DIR)) {
    if (/^\.notify-sent-\d{8}$/.test(f) && f !== `.notify-sent-${todayStr}`) {
      unlinkSync(join(DATA_DIR, f));
    }
  }
} catch (e) {
  console.warn('[notify] 清理旧标记文件失败（非致命）:', e.message);
}

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
    '20260603', '20260717', '20260817',
    '20260924', '20260925', '20261005',
    '20261009', '20261225', '20261231'
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

// 单个 URL 发送，网络层失败（fetch failed / 超时）时自动重试，
// 避免因偶发网络抖动（如运营商/CI runner 到腾讯 API 的瞬时连接问题）导致整日推送缺失。
async function sendWithRetry(url, body, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000), // 15s 超时，避免卡死
      });
      const result = await res.json();
      return { ok: result.errcode === 0, result };
    } catch (e) {
      const isLastAttempt = attempt === maxRetries;
      console.error(`[notify] 发送请求失败 (第${attempt}/${maxRetries}次):`, e.message);
      if (isLastAttempt) return { ok: false, error: e };
      const delayMs = attempt * 2000; // 2s, 4s 递增等待
      console.log(`[notify] ${delayMs / 1000}s 后重试...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

let successCount = 0;
const body = JSON.stringify(message);
for (const url of webhookUrls) {
  const { ok, result, error } = await sendWithRetry(url, body);
  if (ok) {
    successCount++;
    console.log(`[notify] 推送成功! (${displayDate}, ${upCount}涨/${downCount}跌/${neutralCount}平) [${successCount}/${webhookUrls.length}]`);
  } else if (result) {
    console.error(`[notify] 推送失败: errcode=${result.errcode}, errmsg=${result.errmsg}`);
  } else {
    console.error(`[notify] 该 Webhook 多次重试后仍失败:`, error?.message);
  }
}

if (successCount === 0) process.exit(1);
console.log(`[notify] 全部完成: ${successCount}/${webhookUrls.length} 个群推送成功`);

// 至少成功推送一个群，才写入今日已推送标记，避免全部失败时误标记导致次日无法重推
try {
  writeFileSync(markerPath, new Date().toISOString());
  console.log(`[notify] 已写入去重标记: .notify-sent-${todayStr}`);
} catch (e) {
  console.warn('[notify] 写入去重标记失败（非致命）:', e.message);
}
