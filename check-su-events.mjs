// check-su-events.mjs - 检查 Shift Up 剑星2 相关新闻
import fs from 'fs';

const content = JSON.parse(fs.readFileSync('C:/Users/wrenwszhang/data/content.json', 'utf8'));

console.log('=== events (Shift Up / Stellar Blade / 剑星 相关) ===');
const suEvents = content.events.filter(e =>
  e.company.includes('Shift Up') ||
  e.title.includes('Stellar') ||
  e.title.includes('剑星') ||
  e.title.includes('Shiftup')
);
if (suEvents.length === 0) {
  console.log('(无相关条目)');
} else {
  suEvents.forEach(e => console.log(`[${e.date}] ${e.title.slice(0,80)}`));
}

console.log('\n=== industryNews (Shift Up / Stellar Blade / 剑星 相关) ===');
const suNews = content.industryNews.filter(e =>
  e.company.includes('Shift Up') ||
  e.title.includes('Stellar') ||
  e.title.includes('剑星') ||
  e.title.includes('Shiftup')
);
if (suNews.length === 0) {
  console.log('(无相关条目)');
} else {
  suNews.forEach(e => console.log(`[${e.date}] ${e.title.slice(0,80)}`));
}

console.log('\n=== 所有 events date 列表 ===');
content.events.forEach(e => console.log(e.date, e.company.slice(0,15)));
