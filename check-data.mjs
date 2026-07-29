import fs from 'fs';
const d = JSON.parse(fs.readFileSync('data/20260610.json', 'utf8'));
const names = { nc: 'NC', pearlAbyss: 'PA', shiftUp: 'SU', krafton: 'Krafton', nexonGames: 'Nexon', netmarble: 'Netmarble' };
for (const [key, label] of Object.entries(names)) {
  const s = d[key];
  if (s) console.log(`${label}: ${s.changePercent} ${s.changeClass} price=${s.price}`);
  else console.log(`${label}: no data`);
}
// Check indices
if (d.indices) d.indices.forEach(i => console.log(`Index: ${i.name} ${i.changePercent}%`));
