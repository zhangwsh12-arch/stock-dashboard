import fs from 'fs';
const s = fs.readFileSync('data/content.json', 'utf8');
try {
  JSON.parse(s);
  console.log('JSON is valid');
} catch(e) {
  const pos = parseInt(e.message.match(/position (\d+)/)?.[1] || '0');
  const before = s.substring(pos - 50, pos);
  const after = s.substring(pos, pos + 50);
  console.log('Error:', e.message);
  console.log('Around error position:');
  console.log('Before:', JSON.stringify(before));
  console.log('After:', JSON.stringify(after));
  // Also find the line number
  const lines = s.substring(0, pos).split('\n');
  console.log('Line:', lines.length, 'Col:', lines[lines.length-1].length + 1);
}
