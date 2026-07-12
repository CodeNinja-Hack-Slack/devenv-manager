# ============================================================================
# DevEnv Manager - one-click launcher (Windows / PowerShell)
#
# Modes:
#   electron  (default) Build UI + main process, launch Electron desktop app
#                         -> 真实测试模式（读写系统环境变量、真实扫描等）
#   ui        Start Vite dev server, open browser preview (mock data)
#   hmr       Vite dev server + Electron with HMR and DevTools (best for dev)
#   test      Run Vitest engine unit tests
#   build     Build production bundle (dist-ui + out)
#
# Usage:
#   .\start.ps1                 # same as .\start.ps1 -Mode electron  (real desktop app)
#   .\start.ps1 -Mode ui        # browser preview with mock data
#   .\start.ps1 -Mode hmr       # electron + HMR + DevTools
#   .\start.ps1 -NoBuild        # skip rebuild, launch electron directly (fast re-test)
#   .\start.ps1 electron -NoBuild
#
# If PowerShell blocks the script, run:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
# ============================================================================

param(
    [ValidateSet("electron", "ui", "hmr", "test", "build")]
    [string]$Mode = "electron",

    # 跳过 UI + 主进程构建，直接启动 electron（产物 dist-ui / out 已存在时）
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 全局：确保 electron 二进制走国内镜像下载（避免 GitHub 被墙/卡死），且不跳过二进制
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = ""
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"

function Ensure-Deps {
    if (-not (Test-Path "node_modules")) {
        Write-Host "[setup] node_modules not found, running npm install..." -ForegroundColor Cyan
        npm install
    }
    else {
        Write-Host "[setup] dependencies already installed." -ForegroundColor DarkGray
    }
}

function Test-ElectronBinary {
    $bin = Join-Path $root "node_modules/electron/dist/electron.exe"
    return (Test-Path $bin)
}

function Install-Electron {
    # 1) 清掉可能阻止二进制下载的环境变量（沙箱/CI 常设 ELECTRON_SKIP_BINARY_DOWNLOAD=1）
    Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = ""

    # 2) 走国内 npmmirror 镜像拉二进制（避免 GitHub Releases 被墙/超时卡死）
    $env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"

    if (Test-Path "node_modules/electron/install.js") {
        # 3) 直接跑 electron 自带的安装脚本：它会忽略 npm 的「已满足」判断，强制重新下载二进制
        Write-Host "[electron] Binary missing -> downloading from npmmirror (this can take a while)..." -ForegroundColor Yellow
        node node_modules/electron/install.js
    }
    else {
        Write-Host "[electron] electron package not found, running npm install electron..." -ForegroundColor Yellow
        npm install electron
    }
}

function Build-IfNeeded {
    if ($NoBuild) {
        $uiBuilt = Test-Path "dist-ui/index.html"
        $mainBuilt = (Test-Path "out/main.js") -and (Test-Path "out/preload.cjs")
        if ($uiBuilt -and $mainBuilt) {
            Write-Host "[build] -NoBuild: using existing dist-ui + out, skipping build." -ForegroundColor DarkGray
            return
        }
        Write-Host "[build] -NoBuild set but artifacts missing, building anyway..." -ForegroundColor Yellow
    }
    Write-Host "[build] Building UI + main process..." -ForegroundColor Cyan
    npm run electron:build
}

function Start-Electron {
    if (-not (Test-ElectronBinary)) { Install-Electron }
    if (-not (Test-ElectronBinary)) {
        Write-Host "[error] Electron 二进制仍缺失，无法启动桌面端。" -ForegroundColor Red
        Write-Host "[hint] 可手动执行以下任一方案：" -ForegroundColor DarkGray
        Write-Host "        1) 设镜像后重装: `$env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'; npm install electron" -ForegroundColor DarkGray
        Write-Host "        2) 若走代理: 设置 HTTP_PROXY / HTTPS_PROXY 后重跑本脚本" -ForegroundColor DarkGray
        Write-Host "        3) 想先跳过桌面端: .\start.ps1 -Mode ui  (浏览器预览，mock 数据)" -ForegroundColor DarkGray
        exit 1
    }
    Build-IfNeeded
    Write-Host "[electron] Launching desktop app (real environment)..." -ForegroundColor Green
    # 用本地 electron 二进制路径启动（双击脚本时 node_modules/.bin 不在 PATH 上，裸 `electron` 会找不到）
    $electronCmd = Join-Path $root "node_modules/.bin/electron.cmd"
    if (Test-Path $electronCmd) {
        & $electronCmd .
    }
    else {
        npx electron .
    }
}

# 双击脚本启动时 $MyInvocation.Line 为空；在已打开的终端里手动敲命令时非空。
# 双击场景需要停留窗口，避免「闪退」看不到输出。
$launchedByClick = [string]::IsNullOrWhiteSpace($MyInvocation.Line)

try {
    Ensure-Deps

    switch ($Mode) {
        "electron" {
            Start-Electron
        }
        "ui" {
            Write-Host "[ui] Starting Vite dev server (browser preview with mock data)..." -ForegroundColor Green
            Write-Host "[ui] Browser will open at http://localhost:5173" -ForegroundColor DarkGray
            npm run dev
        }
        "hmr" {
            if (-not (Test-ElectronBinary)) { Install-Electron }
            if (-not (Test-ElectronBinary)) {
                Write-Host "[warn] Electron binary missing. Falling back to UI preview (no desktop)." -ForegroundColor Red
                npm run dev
                return
            }
            Write-Host "[hmr] Vite dev server (background) + Electron with HMR + DevTools..." -ForegroundColor Green
            Start-Process -FilePath "npm" -ArgumentList "run", "dev"
            Start-Sleep -Seconds 4
            $env:VITE_DEV_SERVER_URL = "http://localhost:5173"
            npm run electron:hmr
        }
        "test" {
            Write-Host "[test] Running Vitest engine unit tests..." -ForegroundColor Green
            npm test
        }
        "build" {
            Write-Host "[build] Building production bundle..." -ForegroundColor Green
            npm run electron:build
        }
    }
}
catch {
    Write-Host ""
    Write-Host "[fatal] 启动失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
    if ($launchedByClick) {
        Read-Host "`n按回车键退出"
    }
}
