#Requires -Version 5.1
<#
.SYNOPSIS
  Store secrets in free GitHub Actions encrypted secrets.

.DESCRIPTION
  Reads KEY=VALUE pairs from a .env file, encrypts each value with the
  repository's public key (libsodium sealed box) and uploads it through the
  GitHub REST API. GitHub Actions secrets are free for public and private
  repositories.

  Nothing is written to disk except the source .env file. Values never appear
  in command-line arguments (they are streamed over stdin to the Python sealer).

.EXAMPLE
  $env:GITHUB_TOKEN = 'ghp_...'
  ./scripts/set-github-secrets.ps1 -Repo Wiz-cmd/kolab-backend -EnvFile .env `
    -Keys DATABASE_URL,JWT_SECRET,GITHUB_MODELS_TOKEN

.NOTES
  The token needs the "Secrets: Read and write" repository permission
  (fine-grained) or the classic "repo" scope.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,

    [string]$Token = $env:GITHUB_TOKEN,

    [string]$EnvFile = ".env",

    # Optional allow-list. When omitted, every key in .env is uploaded.
    [string[]]$Keys,

    # Encrypt and report without uploading anything.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw "Set -Token or `$env:GITHUB_TOKEN to a GitHub token with secrets:write."
}
if (-not (Test-Path $EnvFile)) {
    throw "Env file not found: $EnvFile"
}

function Resolve-Python {
    if ($env:PYTHON -and (Test-Path $env:PYTHON)) { return $env:PYTHON }
    foreach ($name in @("python", "python3")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return "$($py.Source) -3" }
    throw "Python 3 was not found. Install it or set `$env:PYTHON to python.exe."
}

$python = Resolve-Python
$pythonExe = $python
$pythonArgs = @()
if ($python -match "\s-3$") {
    $pythonExe = $python.Substring(0, $python.Length - 3)
    $pythonArgs = @("-3")
}

# Ensure PyNaCl is available (idempotent, free). Native stderr must not trip
# $ErrorActionPreference=Stop, so probe with a local SilentlyContinue scope.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
& $pythonExe @pythonArgs -c "import nacl" 2>&1 | Out-Null
$hasNacl = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $previousEap

if (-not $hasNacl) {
    Write-Host "Installing PyNaCl (one-time)..." -ForegroundColor Yellow
    $ErrorActionPreference = 'SilentlyContinue'
    & $pythonExe @pythonArgs -m pip install --user --quiet pynacl 2>&1 | Out-Null
    $pipExit = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($pipExit -ne 0) { throw "Could not install PyNaCl." }
}

$sealer = Join-Path $PSScriptRoot "github_secret_seal.py"
$apiBase = "https://api.github.com/repos/$Repo/actions/secrets"
$headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "kolab-secret-setup"
}

Write-Host "Fetching public key for $Repo..." -ForegroundColor Cyan
$publicKey = Invoke-RestMethod -Uri "$apiBase/public-key" -Headers $headers
if (-not $publicKey.key -or -not $publicKey.key_id) {
    throw "GitHub did not return a public key. Check the token permissions and repo name."
}

# Parse .env: ignore comments/blanks, strip surrounding quotes.
$pairs = @{}
foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
    $idx = $trimmed.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    if ($value.Length -ge 2 -and (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    $pairs[$key] = $value
}

$selected = if ($Keys) { $Keys } else { $pairs.Keys }
$count = 0

foreach ($key in $selected) {
    if (-not $pairs.ContainsKey($key)) {
        Write-Warning "Skipping $key (not found in $EnvFile)"
        continue
    }
    $value = $pairs[$key]
    if ([string]::IsNullOrEmpty($value)) {
        Write-Warning "Skipping $key (empty value)"
        continue
    }

    $payload = @{ key = $publicKey.key; value = $value } | ConvertTo-Json -Compress
    $ErrorActionPreference = 'SilentlyContinue'
    $encrypted = ($payload | & $pythonExe @pythonArgs $sealer 2>$null)
    $sealExit = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($sealExit -ne 0 -or [string]::IsNullOrWhiteSpace($encrypted)) {
        throw "Failed to encrypt $key"
    }

    $body = @{
        encrypted_value = $encrypted.Trim()
        key_id          = $publicKey.key_id
    } | ConvertTo-Json -Compress

    if ($DryRun) {
        Write-Host "  would set $key (dry run)" -ForegroundColor Yellow
    } else {
        Invoke-RestMethod -Uri "$apiBase/$key" -Method Put -Headers $headers -Body $body -ContentType "application/json" | Out-Null
        Write-Host "  set $key" -ForegroundColor Green
    }
    $count++
}

Write-Host "Done: $count secret(s) stored in $Repo." -ForegroundColor Cyan
