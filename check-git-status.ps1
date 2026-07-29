cd C:\Users\wrenwszhang
git -c core.safecrlf=false status --short data/content.json index.html 2>$null | Tee-Object -FilePath "git-status-output.txt"
Write-Host "--- content of git-status-output.txt ---"
Get-Content "git-status-output.txt" | Write-Host
