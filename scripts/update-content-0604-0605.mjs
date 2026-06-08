// update-content-0604-0605.mjs - 补充 6/4~6/5 events 和 industryNews
import fs from 'fs';

const path = 'C:/Users/wrenwszhang/data/content.json';
const content = JSON.parse(fs.readFileSync(path, 'utf8'));

// 新增 6/4 和 6/5 的 events
const newEvents = [
  {
    company: 'NC',
    color: '#3b82f6',
    title: '<strong>NC 6/4 定期维护后用户活跃度维持高位</strong>——Aion 2 韩国预约突破120万，6月全球发布前最后准备阶段。Q1财报超预期（营业利润YoY +1700%）持续发酵，外资连续3日净买入。',
    source: 'NC Soft/AION2 공식',
    date: '06.04',
    url: 'https://aion2.plaync.com/ko-kr/board/notice/list',
  },
  {
    company: '六大游戏公司',
    color: '#6b7185',
    title: '<strong>6/5 韩股暴跌传导至游戏板块</strong>——KOSPI 盘中跌超6%触发熔断机制，外资因杠杆投资组合调整大幅抛售。游戏股全线重挫：NC -4.74%、Pearl Abyss -7.11%、Shift Up -2.03%。Aion 2 全球发布前外资调仓是主要驱动。',
    source: 'DailyAlpha/NH투자증권',
    date: '06.05',
    url: '',
  },
  {
    company: 'Pearl Abyss',
    color: '#a855f7',
    title: '<strong>PA 6/5 重挫 -7.11%</strong>——韩股整体暴跌（KOSPI熔断）传导至游戏板块，前期 Crimson Desert 500万套利好已充分定价，外资调仓导致无差别抛售。Q1扭亏为盈预期支撑估值底部。',
    source: 'Naver증권/DailyAlpha',
    date: '06.05',
    url: '',
  },
];

// 找到插入位置（06.02 NC 条目之后）
const events = content.events;
let insertIdx = -1;
for (let i = 0; i < events.length; i++) {
  if (events[i].date === '06.02' && events[i].company.includes('NC')) { insertIdx = i; break; }
}
if (insertIdx >= 0) {
  events.splice(insertIdx + 1, 0, ...newEvents);
  console.log(`✅ events 已插入 ${newEvents.length} 条，共 ${events.length} 条`);
} else {
  events.push(...newEvents);
  console.log(`⚠️ 未找到插入位置，已 push 到末尾，共 ${events.length} 条`);
}

// 新增 industryNews（6/1~6/5 汇总）
const newIndustry = [
  {
    company: '六大游戏公司',
    color: '#6b7185',
    title: '<strong>6月第一周游戏股：全球发布前震荡整固</strong>——6/1~6/5 游戏板块整体震荡，NC 因 Aion 2 全球发布临近相对抗跌（-4.74%），PA 因前期涨幅较大回调较多（-7.11%）。6/5 韩股暴跌（KOSPI熔断）导致外资无差别抛售，游戏股全线重挫。',
    source: 'GameTalk/DailyAlpha',
    date: '06.01~05',
    url: '',
  },
  {
    company: 'NC',
    color: '#3b82f6',
    title: '<strong>Aion 2 全球发布进入最后倒计时</strong>——韩国预约突破120万，6/4 定期维护后用户活跃度维持高位。Q1 营业利润 YoY +1700% 持续作为估值锚，6月全球发布将是关键催化剂兑现节点。',
    source: 'NC Soft IR/AION2 공식',
    date: '06.01~05',
    url: 'https://aion2.plaync.com/ko-kr/board/notice/list',
  },
];

// industryNews 去重
const industry = content.industryNews;
const existDates = industry.map(e => e.date);
const toAdd = newIndustry.filter(n => !existDates.includes(n.date));
if (toAdd.length > 0) {
  industry.push(...toAdd);
  console.log(`✅ industryNews 已追加 ${toAdd.length} 条，共 ${industry.length} 条`);
} else {
  console.log(`⚠️ industryNews 日期已存在，跳过`);
}

// 写回
fs.writeFileSync(path, JSON.stringify(content, null, 2), 'utf8');
console.log(`✅ content.json 已保存，updatedAt: ${content.meta.updatedAt}`);
