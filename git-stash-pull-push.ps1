# git-stash-pull-push.ps1 - Stash, pull, apply, push
cd C:\Users\wrenwszhang

Write-Host "=== Git Stash ===" -ForegroundColor Cyan
git stash 2>&1 | ForEach-Object { $_.ToString() } | Write-Host

Write-Host "`n=== Git Pull (rebase) ===" -ForegroundColor Cyan
git pull --rebase origin main 2>&1 | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^warning:' } | Write-Host

Write-Host "`n=== Git Stash Pop ===" -ForegroundColor Cyan
git stash pop 2>&1 | ForEach-Object { $_.ToString() } | Write-Host

Write-Host "`n=== Check for conflicts ===" -ForegroundColor Cyan
$conflicts = git diff --name-only --diff-filter=U 2>&1 | ForEach-Object { $_.ToString() }
if ($conflicts -and $conflicts.Length -gt 0) {
    Write-Host "CONFLICTS FOUND:" -ForegroundColor Red
    $conflicts | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host "`nAborting rebase and stash pop..." -ForegroundColor Yellow
    git rebase --abort 2>&1 | Out-Null
    Write-Host "Please resolve manually" -ForegroundColor Red
} else {
    Write-Host "No conflicts" -ForegroundColor Green

    Write-Host "`n=== Git Add & Commit ===" -ForegroundColor Cyan
    git add data/content.json index.html 2>&1 | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^warning:' } | Write-Host
    git commit -m "feat: add SGF Stellar Blade 2 announce, update SU analysis" 2>&1 | ForEach-Object { $_.ToString() } | Write-Host

    Write-Host "`n=== Git Push ===" -ForegroundColor Cyan
    git push origin main 2>&1 | ForEach-Object { $_.ToString() } | Write-Host

    Write-Host "`n=== Git Log (last 3) ===" -ForegroundColor Cyan
    git log --oneline -3 2>&1 | ForEach-Object { $_.ToString() } | Write-Host
}
