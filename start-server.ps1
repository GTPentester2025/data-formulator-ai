# Launch Data Formulator as a shared multi-user server.
#
#   .\start-server.ps1
#
# Each person signs in with their own account and sees only their own data.
# See MULTIUSER.md for the full explanation.

$ErrorActionPreference = "Stop"

# --- accounts ---------------------------------------------------------
$env:AUTH_PROVIDER   = "local"     # username/password accounts held by this app
$env:ALLOW_ANONYMOUS = "false"     # no access at all without signing in

# The signing key for login sessions. Generated once and kept in a file:
# regenerating it would sign everyone out at every restart.
$keyFile = Join-Path $PSScriptRoot ".flask_secret"
if (-not (Test-Path $keyFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    ($bytes | ForEach-Object { $_.ToString("x2") }) -join "" | Set-Content -Path $keyFile -Encoding ascii -NoNewline
    Write-Host "Created a new session signing key at $keyFile - keep it." -ForegroundColor Yellow
}
$env:FLASK_SECRET_KEY = (Get-Content $keyFile -Raw).Trim()

# --- data retention ---------------------------------------------------
# Uploaded files, tables and sessions are deleted after 2 hours of
# inactivity. Accounts themselves are not affected.
$env:WORKSPACE_BACKEND = "ephemeral"
$env:EPHEMERAL_WORKSPACE_TTL_HOURS = "2"
$env:EPHEMERAL_WORKSPACE_CLEANUP_INTERVAL_SECONDS = "600"

# --- reduced surface --------------------------------------------------
$env:DISABLE_DATA_CONNECTORS = "true"   # file upload only, no databases
$env:DISABLE_DISPLAY_KEYS    = "true"   # never show server-side API keys

# 0.0.0.0 is required: on a loopback bind the app runs in single-user mode
# and every visitor would share one workspace.
Write-Host "Starting on http://0.0.0.0:5567 - each account gets its own data." -ForegroundColor Green
uv run data_formulator --host 0.0.0.0 -p 5567
