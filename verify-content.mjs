import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const d = require('C:/Users/wrenwszhang/data/content.json');

console.log('=== Validation Report ===');
console.log('events:', d.events.length);
console.log('industryNews:', d.industryNews.length);
console.log('labels:', d.compareChart.labels.length);
console.log('last label:', d.compareChart.labels[d.compareChart.labels.length - 1]);
let allMatch = true;
d.compareChart.datasets.forEach(ds => {
  const ok = ds.data.length === d.compareChart.labels.length;
  console.log(ds.label + ':', ds.data.length, 'data points, match:', ok);
  if (!ok) allMatch = false;
});
console.log('\nAll datasets match labels:', allMatch ? 'PASS ✅' : 'FAIL ❌');
console.log('\nLast 5 events:');
d.events.slice(-5).forEach((e, i) => console.log(' ', e.date, e.company || '', e.title.substring(0, 60)));
