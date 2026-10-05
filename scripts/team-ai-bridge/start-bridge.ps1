# Team AI bridge for Windows.
# Usage (from the repo folder): powershell -ExecutionPolicy Bypass -File scripts\team-ai-bridge\start-bridge.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
if (-not (Test-Path 'bridge.config')) {
    Copy-Item 'bridge.config.example' 'bridge.config'
    Write-Host 'Created scripts\team-ai-bridge\bridge.config. Fill in HPC_USERNAME, TEAM_AI_KEY and TUNNEL_TOKEN, then run this again.'
    notepad 'bridge.config'
    exit 1
}
$python = $null
foreach ($candidate in @('py', 'python', 'python3')) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) { $python = $candidate; break }
}
if (-not $python) {
    Write-Host 'Python 3 is required. Install it with: winget install -e --id Python.Python.3.12'
    exit 1
}
if ($python -eq 'py') { & py -3 bridge.py @args } else { & $python bridge.py @args }
exit $LASTEXITCODE
