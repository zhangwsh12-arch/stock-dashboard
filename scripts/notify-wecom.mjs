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

[<font color="comment">\u{1F517} 查看完整看板\u2192</>](${DASHBOARD_URL})`,
  },
};

// ====== 发送到企业微信 ======
const webhookUrl = process.env.WECOM_WEBHOOK_URL;
if (!webhookUrl || !webhookUrl.startsWith('https://qyapi.weixin.qq.com')) {
  console.error('[notify] WECOM_WEBHOOK_URL 未设置或格式不正确');
  console.log('[notify] 消息内容预览:');
  console.log(JSON.stringify(message.markdown.content, null, 2));
  process.exit(0); // 非致命错误，不阻断 workflow
}

try {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  const result = await res.json();

  if (result.errcode === 0) {
    console.log(`[notify] 推送成功! (${displayDate}, ${upCount}涨/${downCount}跌/${neutralCount}平)`);
  } else {
    console.error(`[notify] 推送失败: errcode=${result.errcode}, errmsg=${result.errmsg}`);
    process.exit(1);
  }
} catch (e) {
  console.error('[notify] 发送请求失败:', e.message);
  process.exit(1);
}
