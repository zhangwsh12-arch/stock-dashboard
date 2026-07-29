# git-pull-then-push.ps1 - Pull then push
cd C:\Users\wrenwszhang

Write-Host "=== Git Pull ===" -ForegroundColor Cyan
git pull --rebase origin main 2>&1 | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^warning:' } | Write-Host

Write-Host "`n=== Check for conflicts ===" -ForegroundColor Cyan
$conflicts = git diff --name-only --diff-filter=U 2>&1 | ForEach-Object { $_.ToString() }
if ($conflicts -and $conflicts.Length -gt 0) {
    Write-Host "CONFLICTS FOUND:" -ForegroundColor Red
    $conflicts | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    Write-Host "Aborting rebase..." -ForegroundColor Yellow
    git rebase --abort 2>&1 | Out-Null
    Write-Host "Please resolve manually" -ForegroundColor Red
} else {
    Write-Host "No conflicts - rebase succeeded" -ForegroundColor Green

    Write-Host "`n=== Git Push ===" -ForegroundColor Cyan
    git push origin main 2>&1 | ForEach-Object { $_.ToString() } | Write-Host

    Write-Host "`n=== Git Log (last 3) ===" -ForegroundColor Cyan
    git log --oneline -3 2>&1 | ForEach-Object { $_.ToString() } | Write-Host
}
