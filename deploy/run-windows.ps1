# Recapper on your Windows PC, one command (PowerShell):
#   irm https://raw.githubusercontent.com/Saiberia/teste/claude/cloud-mode-claude-code-g6q3pn/deploy/run-windows.ps1 | iex
# Installs uv (Python manager) + Recapper into your user profile, no admin rights needed.
# Re-run the same command (or the "Recapper" shortcut on the Desktop) to start again / update.
$ErrorActionPreference = "Stop"
$Branch  = "claude/cloud-mode-claude-code-g6q3pn"
$Raw     = "https://raw.githubusercontent.com/Saiberia/teste/$Branch/deploy/run-windows.ps1"
$Zip     = "https://github.com/Saiberia/teste/archive/refs/heads/$Branch.zip"
$AppDir  = Join-Path $env:LOCALAPPDATA "Recapper"
$Port    = if ($env:RECAPPER_PORT) { $env:RECAPPER_PORT } else { "8000" }
New-Item -ItemType Directory -Force $AppDir | Out-Null

# 1. uv (downloads Python 3.12 on its own)
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv..." -ForegroundColor Cyan
  powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

# 2. Recapper + local speech recognition (first run takes a few minutes)
Write-Host "Installing / updating Recapper..." -ForegroundColor Cyan
uv tool install --force --python 3.12 --reinstall-package recapper "recapper[asr] @ $Zip"
if ($LASTEXITCODE -ne 0) { throw "Recapper install failed" }

# 3. Permanent access token (the extension and the site use it)
$TokFile = Join-Path $AppDir "token.txt"
if (-not (Test-Path $TokFile)) { [guid]::NewGuid().ToString("N") | Set-Content -NoNewline $TokFile }
$Token = (Get-Content $TokFile -Raw).Trim()

# 4. Desktop shortcut that re-runs this script
try {
  Invoke-WebRequest $Raw -OutFile (Join-Path $AppDir "run.ps1") -UseBasicParsing
  $Cmd = "@echo off`r`npowershell -ExecutionPolicy Bypass -NoProfile -File `"%LOCALAPPDATA%\Recapper\run.ps1`"`r`n"
  Set-Content -Path (Join-Path ([Environment]::GetFolderPath("Desktop")) "Recapper.cmd") -Value $Cmd -Encoding ASCII
} catch { Write-Host "Shortcut not created: $_" -ForegroundColor Yellow }

# 5. Defaults for a local OpenAI-compatible proxy (Gemini proxy on port 8045).
#    Everything can be changed later in Settings; saved settings win over these.
if (-not $env:RECAPPER_LLM)          { $env:RECAPPER_LLM = "openai" }
if (-not $env:OPENAI_BASE_URL)       { $env:OPENAI_BASE_URL = "http://127.0.0.1:8045/v1" }
if (-not $env:RECAPPER_OPENAI_MODEL) { $env:RECAPPER_OPENAI_MODEL = "gemini-2.5-flash" }
# Speech recognition on the CPU: the GPU path needs CUDA 12 + cuDNN 9 DLLs that most PCs don't have.
if (-not $env:RECAPPER_WHISPER_DEVICE) { $env:RECAPPER_WHISPER_DEVICE = "cpu" }

# 6. Start the server, open the browser when it answers
$Url = "http://127.0.0.1:$Port"
$Exe = Join-Path $env:USERPROFILE ".local\bin\recapper.exe"
if (-not (Test-Path $Exe)) { $Exe = "recapper" }
$Proc = Start-Process $Exe -ArgumentList @("serve", "--port", $Port, "--token", $Token, "--data-dir", "`"$AppDir\data`"") -NoNewWindow -PassThru
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-RestMethod "$Url/api/health" -TimeoutSec 2 | Out-Null; break } catch { if ($Proc.HasExited) { throw "Recapper stopped, see messages above" } }
}
Start-Process "$Url/?token=$Token"
Write-Host ""
Write-Host "Recapper is running:  $Url/?token=$Token" -ForegroundColor Green
Write-Host "Extension settings:   server $Url   token $Token" -ForegroundColor Green
Write-Host "Keep this window open. Close it (or Ctrl+C) to stop Recapper." -ForegroundColor Green
Wait-Process -Id $Proc.Id
