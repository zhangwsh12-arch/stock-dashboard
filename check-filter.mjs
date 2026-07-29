const fs = require('fs');
const c = JSON.parse(fs.readFileSync('data/content.json', 'utf8'));
[29, 30].forEach(i => {
  const e = c.industryNews[i];
  const plain = (e.title || '').replace(/<[^>]+>/g, '');
  const korean = (plain.match(/[가-힣]/g) || []).length;
  const chinese = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  console.log(e.date, e.company, 'korean:', korean, 'chinese:', chinese, 'pass:', korean <= chinese || korean <= 5);
});
