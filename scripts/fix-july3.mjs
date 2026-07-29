import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf-8'));

// 从 _allHistory 获取7/3的SU数据
const history = data.shiftUp._allHistory;
const july3Data = history.find(h => h.date === '20260703');
console.log('July 3 SU data:', JSON.stringify(july3Data));

if (!july3Data) {
  console.error('ERROR: No July 3 data found in _allHistory');
  process.exit(1);
}

const prevDayClose = history[history.length - 2]?.close;
console.log('Previous day close:', prevDayClose);

// 创建正确的20260703.json
const priceChange = july3Data.close - prevDayClose;
const changePercent = (priceChange / prevDayClose) * 100;
const changeClass = priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'neutral';

const fileData = {
  meta: {
    date: '20260703',
    dateDisplay: '7月（截至3日）',
    fetchedAt: data.meta.fetchedAt,
    source: data.meta.source,
    updateCount: data.meta.updateCount
  },
  shiftUp: {
    code: '462870',
    name: 'Shift Up',
    color: '#ff6b9d',
    price: String(july3Data.close),
    previousClose: String(prevDayClose),
    high: String(july3Data.high),
    low: String(july3Data.low),
    change: String(priceChange),
    changePercent: (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%',
    changeClass: changeClass,
    per: data.shiftUp.per,
    pbr: data.shiftUp.pbr,
    marketCap: data.shiftUp.marketCap,
    _allHistory: data.shiftUp._allHistory
  },
  companies: data.companies,
  perComparison: data.perComparison,
  chartData: data.chartData.filter(d => d.date <= '20260703'),
  indices: data.indices
};

fs.writeFileSync(path.join(DATA_DIR, '20260703.json'), JSON.stringify(fileData, null, 2), 'utf-8');
console.log('✅ Created data/20260703.json');

// 更新dates.json
const datesFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dates.json'), 'utf-8'));
if (!datesFile.dates.includes('20260703')) {
  datesFile.dates.unshift('20260703');
}
fs.writeFileSync(path.join(DATA_DIR, 'dates.json'), JSON.stringify(datesFile, null, 2), 'utf-8');
console.log('✅ Updated dates.json with 20260703');

// 更新latest.json的meta.date为正确值
data.meta.date = '20260703';
data.meta.dateDisplay = '7月（截至3日）';
fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(data, null, 2), 'utf-8');
console.log('✅ Updated latest.json meta to 20260703');

console.log('\n📊 Summary:');
console.log(`   Shift Up: ₩${fileData.shiftUp.price} (${fileData.shiftUp.changePercent})`);
console.log(`   chartData: ${fileData.chartData.length} days`);
console.log(`   dates list: ${datesFile.dates.length} entries`);
