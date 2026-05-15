import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// 读取5月14日的数据（包含完整的_allHistory）
const mayData = JSON.parse(readFileSync(join(DATA_DIR, '20260514.json'), 'utf-8'));
const allHistory = mayData.shiftUp?._allHistory || [];

console.log(`_allHistory total: ${allHistory.length} entries`);

// 提取4月的完整数据
const aprilHistory = allHistory
  .filter(h => h.date.startsWith('202604'))
  .sort((a, b) => a.date.localeCompare(b.date));

console.log(`April data: ${aprilHistory.length} entries`);
console.log('April dates:', aprilHistory.map(h => h.date).join(', '));

// 构建完整的chartData
const fullChartData = aprilHistory.map(h => ({
  date: h.date,
  label: `${parseInt(h.date.slice(4,6))}/${parseInt(h.date.slice(6,8))}`,
  price: h.close,
}));

// 修复20260430.json
const filePath = join(DATA_DIR, '20260430.json');
const data = JSON.parse(readFileSync(filePath, 'utf-8'));
const existingCount = data.chartData?.length || 0;

console.log(`\n20260430.json: ${existingCount} → ${fullChartData.length} days`);

data.chartData = fullChartData;
data.meta.fetchedAt = new Date().toISOString();
data.meta.source = 'Naver Finance / Multi-source v3 (手动修复4月完整数据)';

writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
console.log('✅ 20260430.json 已修复');

// 同时修复4月的其他文件
import { readdirSync } from 'fs';
const files = readdirSync(DATA_DIR)
  .filter(f => f.startsWith('202604') && f.endsWith('.json') && f !== 'latest.json');

for (const file of files) {
  const fp = join(DATA_DIR, file);
  const d = JSON.parse(readFileSync(fp, 'utf-8'));
  const ec = d.chartData?.length || 0;
  
  if (ec < fullChartData.length) {
    const fileDate = file.replace('.json', '');
    const fileDay = parseInt(fileDate.slice(6, 8), 10);
    const truncatedData = fullChartData.filter(item => {
      const day = parseInt(item.date.slice(6, 8), 10);
      return day <= fileDay;
    });
    
    d.chartData = truncatedData;
    d.meta.fetchedAt = new Date().toISOString();
    writeFileSync(fp, JSON.stringify(d, null, 2), 'utf-8');
    console.log(`✅ ${file}: ${ec} → ${truncatedData.length} days`);
  }
}

console.log('\n🎉 所有4月文件修复完成');
