// update-su-sgf-events.mjs - 新增 Stellar Blade 2 SGF 公布相关 events/industryNews
import fs from 'fs';

const path = 'C:/Users/wrenwszhang/data/content.json';
const content = JSON.parse(fs.readFileSync(path, 'utf8'));

// 新增 events（6/5 SGF 公布 Stellar Blade: Blood Rain）
const newEvents = [
  {
    company: 'Shift Up',
    color: '#ec4899',
    title: '<strong>6/5 Summer Game Fest 2026:《Stellar Blade: Blood Rain》正式公布</strong>——续作新主角为Evie（可变拳套武器），前作Eve转为配角，Naytiba敌人回归。SHIFT UP自主发行（不再依赖索尼），目标2027年发售，疑似多平台（PS5/PC/Xbox）同步。SGF公布带动全球关注度飙升。',
    source: 'Summer Game Fest/_SHIFT UP',
    date: '06.05',
    url: 'https://www.youtube.com/watch?v=StellarBladeBloodRain',
  },
];

// 插入到 events 数组（06.05 Pearl Abyss 条目之后）
const events = content.events;
let insertIdx = -1;
for (let i = 0; i < events.length; i++) {
  if (events[i].date === '06.05' && events[i].company.includes('Pearl Abyss')) { insertIdx = i; break; }
}
if (insertIdx >= 0) {
  events.splice(insertIdx + 1, 0, ...newEvents);
  console.log(`✅ events 已插入 ${newEvents.length} 条，共 ${events.length} 条`);
} else {
  // fallback: 找到最后一个 06.05 插入
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].date === '06.05') { insertIdx = i; break; }
  }
  if (insertIdx >= 0) {
    events.splice(insertIdx + 1, 0, ...newEvents);
    console.log(`✅ events fallback 插入，共 ${events.length} 条`);
  } else {
    events.push(...newEvents);
    console.log(`⚠️ 未找到 06.05 位置，已 push 到末尾，共 ${events.length} 条`);
  }
}

// 新增 industryNews（6/1~05 汇总，补充 SGF 催化）
const newIndustry = [
  {
    company: 'Shift Up',
    color: '#ec4899',
    title: '<strong>SGF 2026:《Stellar Blade: Blood Rain》正式公布</strong>——6/5 Summer Game Fest 上 SHIFT UP 公布剑星续作，新主角Evie（可变拳套武器），前作Eve转配角。自主发行（脱离索尼），目标2027年发售。PC版150万套+NIKKE $10亿营收验证IP价值，SGF公布后全球关注度飙升。',
    source: 'Summer Game Fest/_SHIFT UP/KeenGamer',
    date: '06.01~05',
    url: 'https://www.keengamer.com/articles/news/stellar-blade-blood-rain-announced-at-summer-game-fest-2026/',
  },
];

// industryNews 去重（按 date 字段）
const industry = content.industryNews;
const existDates = industry.map(e => e.date);
const toAdd = newIndustry.filter(n => !existDates.includes(n.date));
if (toAdd.length > 0) {
  // 替换已有的 '06.01~05' 条目（如果存在）
  const existIdx = industry.findIndex(e => e.date === '06.01~05');
  if (existIdx >= 0) {
    industry[existIdx] = toAdd[0];
    console.log(`✅ industryNews date=06.01~05 已更新`);
  } else {
    industry.push(...toAdd);
    console.log(`✅ industryNews 已追加 ${toAdd.length} 条，共 ${industry.length} 条`);
  }
} else {
  console.log(`⚠️ industryNews 日期已存在，跳过`);
}

// 写回
fs.writeFileSync(path, JSON.stringify(content, null, 2), 'utf8');
console.log(`✅ content.json 已保存，updatedAt: ${content.meta.updatedAt}`);

// 验证
const verify = JSON.parse(fs.readFileSync(path, 'utf8'));
console.log(`\n=== 验证 ===`);
console.log('events 最后3条:');
verify.events.slice(-4).forEach(e => console.log(`  [${e.date}] ${e.title.slice(0,50)}`));
console.log('industryNews 含 SGF/剑星2:');
verify.industryNews.filter(e => e.title.includes('SGF') || e.title.includes('Blood Rain') || e.title.includes('剑星2')).forEach(e => console.log(`  [${e.date}] ${e.title.slice(0,50)}`));
