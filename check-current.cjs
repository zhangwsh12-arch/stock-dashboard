const d = require('C:/Users/wrenwszhang/data/content.json');
console.log('=== Events ===');
d.events.forEach((e, i) => console.log(i, e.date, (e.company || ''), e.title.substring(0, 70)));
console.log('\n=== IndustryNews ===');
d.industryNews.forEach((e, i) => console.log(i, e.date, (e.company || ''), e.title.substring(0, 70)));
console.log('\n=== Labels last 10 ===');
d.compareChart.labels.slice(-10).forEach((l, i) => console.log(l));
