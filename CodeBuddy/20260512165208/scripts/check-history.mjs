import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// 读取最新的数据文件
const files = ['20260514.json', '20260515.json', 'latest.json'];
for (const file of files) {
  const path = join(DATA_DIR, file);
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    console.log(`\n=== ${file} ===`);
    console.log('meta.date:', data.meta?.date);
    console.log('chartData count:', data.chartData?.length || 0);
    
    // 检查shiftUp._allHistory
    const allHistory = data.shiftUp?._allHistory;
    if (allHistory) {
      console.log('_allHistory length:', allHistory.length);
      const april = allHistory.filter(h => h.date.startsWith('202604'));
      const may = allHistory.filter(h => h.date.startsWith('202605'));
      console.log('April data count:', april.length);
      console.log('May data count:', may.length);
      if (april.length > 0) {
        console.log('April dates:', april.map(h => h.date).join(', '));
      }
    } else {
      console.log('No _allHistory found');
    }
  } catch (err) {
    console.log(`Skip ${file}: ${err.message}`);
  }
}
