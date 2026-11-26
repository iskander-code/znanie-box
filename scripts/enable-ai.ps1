# Включает нейросеть для сайта «Знание в коробке» на этом компьютере.
# 1) проверяет Ollama, 2) разрешает сайту обращаться к ней (OLLAMA_ORIGINS),
# 3) перезапускает Ollama, 4) скачивает модель, если её нет, 5) открывает сайт.
param(
    [string]$Site = 'https://iskander-code.github.io',
    [string]$Model = 'qwen2.5:3b',
    [string]$Url = 'https://iskander-code.github.io/znanie-box/'
)
$ErrorActionPreference = 'Stop'

$cmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $cmd) {
    Write-Host 'Ollama не установлена. Сейчас откроется страница загрузки: установите Ollama и запустите этот файл ещё раз.' -ForegroundColor Yellow
    Start-Process 'https://ollama.com/download'
    exit 1
}

# 2. Разрешение для сайта (добавляем к уже заданным адресам, ничего не стираем).
$current = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
$list = @($current -split ',' | Where-Object { $_.Trim() })
if ($list -notcontains $Site) {
    $list += $Site
    [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', ($list -join ','), 'User')
    Write-Host "Разрешил сайту $Site обращаться к Ollama."
} else {
    Write-Host 'Разрешение для сайта уже есть.'
}
$env:OLLAMA_ORIGINS = ($list -join ',')

# 3. Перезапуск Ollama, чтобы она прочитала новую настройку.
Get-Process | Where-Object { $_.ProcessName -like 'ollama*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$app = Join-Path (Split-Path $cmd.Source) 'ollama app.exe'
if (Test-Path $app) { Start-Process $app } else { Start-Process $cmd.Source -ArgumentList 'serve' -WindowStyle Minimized }
for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -UseBasicParsing 'http://localhost:11434/api/tags' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

# 4. Модель.
$models = & $cmd.Source list
if (-not ($models -match [regex]::Escape($Model))) {
    Write-Host "Скачиваю модель $Model (около 2 ГБ, один раз)..."
    & $cmd.Source pull $Model
}

Write-Host 'Готово! Открываю сайт. Если браузер спросит про доступ к устройствам в локальной сети — разрешите.' -ForegroundColor Green
Start-Process $Url
