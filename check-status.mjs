// check-status.mjs - Check git status of key files
import { execSync } from 'child_process';

const result = execSync('git -c core.safecrlf=false status --short data/content.json index.html', {
  cwd: 'C:/Users/wrenwszhang',
  encoding: 'utf8'
});
console.log('Git status (content.json & index.html):');
console.log(result || '(clean - no output)');

// Also check if content.json is newer than last commit
const lsResult = execSync('git log -1 --format=%H -- data/content.json', {
  cwd: 'C:/Users/wrenwszhang',
  encoding: 'utf8'
});
console.log('\nLast commit for content.json:', lsResult.trim());
