$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = if ($nodeCommand) { [int]((& node --version).TrimStart('v').Split('.')[0]) } else { 0 }
if ($nodeMajor -lt 22) {
    & winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
& npm.cmd install --global --install-links $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'codex-hub installation failed' }
& node (Join-Path $PSScriptRoot 'src/setup.mjs')
if ($LASTEXITCODE -ne 0) { throw 'DSH setup failed' }
Write-Host 'Installation complete. Run codex-hub tui.'
