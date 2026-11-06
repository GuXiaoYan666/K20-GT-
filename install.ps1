# ====================================================================
# lyric-hub Installer 1.0.0 (pure PowerShell, zero external dependency)
# Usage: .\install.ps1 -Mode Install
#        .\install.ps1 -Mode Uninstall
# ====================================================================
param(
    [ValidateSet('Install','Uninstall')]
    [string]$Mode = 'Install'
)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = $ScriptDir
$LogFile     = Join-Path $ScriptDir 'install_detail.log'

# ---------- Logging ----------
function Write-Log {
    param([string]$Level, [string]$Msg)
    $ts = Get-Date -Format 'HH:mm:ss'
    $line = "[$ts] $Level : $Msg"
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}
function Fatal($msg) { Write-Log 'FATAL' $msg; Write-Host ''; try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch {}; exit 1 }

Write-Log 'INFO' "=== lyric-hub Installer 1.0.0 | Mode=$Mode ==="
Write-Log 'INFO' "ScriptDir  = $ScriptDir"

# ---------- Admin check ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fatal 'Must run as Administrator (the .cmd should auto-elevate)' }
Write-Log 'INFO' 'Admin: OK'

# ---------- Node.js locate (auto-download portable if missing) ----------
function Get-NodeExe {
    param([string]$WorkDir)

    # 1) PATH
    try {
        $node = (Get-Command node -ErrorAction Stop).Source
        Write-Log 'INFO' "System Node: $node"
        return $node
    } catch {}

    # 2) Common install paths
    foreach ($p in @(
        "${env:ProgramFiles}\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "${env:LOCALAPPDATA}\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $p) { Write-Log 'INFO' "Found Node: $p"; return $p }
    }

    # 3) Portable cache
    $portableDir = Join-Path $env:TEMP 'lyric-hub-portable-node'
    $portableNode = Join-Path $portableDir 'node.exe'
    if (Test-Path $portableNode) { Write-Log 'INFO' "Portable Node: $portableNode"; return $portableNode }

    # 4) Auto-download portable
    Write-Log 'INFO' 'Node.js not found, auto-downloading portable version (~30MB first time)...'
    try {
        New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
        $zipPath = Join-Path $env:TEMP 'node-portable.zip'
        $url = 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip'
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe -L -o $zipPath $url 2>&1 | Out-Null
        } else {
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        }
        if (-not (Test-Path $zipPath)) { throw 'Download failed' }
        Write-Log 'INFO' 'Downloaded, extracting...'
        Expand-Archive -Path $zipPath -DestinationPath $portableDir -Force
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        $innerNode = Get-ChildItem $portableDir -Recurse -Filter 'node.exe' | Select-Object -First 1
        if ($innerNode) {
            Move-Item $innerNode.FullName (Join-Path $portableDir 'node.exe') -Force
            $innerDir = Split-Path -Parent $innerNode.FullName
            if ($innerDir -ne $portableDir) { Remove-Item $innerDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Write-Log 'INFO' "Portable Node ready: $portableNode"
        return $portableNode
    } catch {
        Write-Log 'ERROR' "Portable Node download failed: $($_.Exception.Message)"
        Fatal 'Cannot download Node.js. Please install manually: https://nodejs.org'
    }
}

$NodeExe = Get-NodeExe -WorkDir $ProjectRoot
Write-Log 'INFO' "Node: $NodeExe"
try { $ver = & $NodeExe -v 2>&1; Write-Log 'INFO' "Node version: $ver" } catch { Fatal "Node.exe failed: $_" }

# ---------- Kill all MCHOSE processes ----------
function Kill-MchoseAll {
    Write-Log 'STEP' 'Kill MCHOSE processes...'
    $killNames = @('MCHOSE HUB Watcher','MCHOSE HUB Agent','MCHOSE HUB Notifier','MCHOSE HUB')
    foreach ($name in $killNames) {
        try {
            Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
                try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Log 'INFO' "  Killed $name (PID $($_.Id))" } catch {}
            }
        } catch {}
    }
    # Any node.exe running our server
    try {
        Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Log 'INFO' '  Killed old server.js node' } catch {}
        }
    } catch {}
    Write-Log 'INFO' 'Waiting 5s...'
    Start-Sleep -Seconds 5
}

# ---------- Find MCHOSE HUB directory ----------
function Find-MHubDir {
    Write-Log 'INFO' '  Searching MCHOSE HUB...'

    # 1) lyric-hub manifest (if already installed)
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $pf) { continue }
        $mf = Join-Path $pf 'M HUB\lyric-hub-manifest.json'
        Write-Log 'INFO' "  Check manifest: $mf (exists=$(Test-Path $mf))"
        if (Test-Path $mf) {
            try {
                $data = Get-Content $mf -Raw | ConvertFrom-Json
                if ($data.appDir -and (Test-Path (Join-Path $data.appDir 'MCHOSE HUB.exe'))) {
                    Write-Log 'INFO' "  Found via manifest: $($data.appDir)"; return $data.appDir
                }
            } catch {}
        }
    }

    # 2) Running process path
    try {
        $proc = Get-Process -Name 'MCHOSE HUB' -ErrorAction Stop | Select-Object -First 1
        if ($proc -and $proc.Path) {
            $dir = Split-Path -Parent $proc.Path
            Write-Log 'INFO' "  Found via process: $dir"; return $dir
        }
    } catch { Write-Log 'INFO' '  No running process' }

    # 3) Default install paths (use $env: NOT [Environment]::GetEnvironmentVariable!)
    Write-Log 'INFO' "  ProgramFiles=$env:ProgramFiles"
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $pf) { Write-Log 'INFO' "  skipping empty ProgramFiles entry"; continue }
        $dir = Join-Path $pf 'M HUB'
        $exe = Join-Path $dir 'MCHOSE HUB.exe'
        Write-Log 'INFO' "  Check default: $dir (exe=$(Test-Path $exe))"
        if (Test-Path $exe) { Write-Log 'INFO' "  Found default: $dir"; return $dir }
    }

    Write-Log 'INFO' '  MCHOSE HUB not found anywhere'; return $null
}

function Launch-MHub {
    param([string]$Dir)
    $exe = Join-Path $Dir 'MCHOSE HUB.exe'
    if (Test-Path $exe) { Start-Process $exe -WorkingDirectory $Dir; Write-Log 'INFO' 'MCHOSE HUB launched' }
}

# ---------- ASAR operations ----------
function Invoke-Asar {
    param([string[]]$AsarArgs)
    $asarCli = Join-Path $ProjectRoot 'node_modules\@electron\asar\bin\asar.mjs'
    if (-not (Test-Path $asarCli)) {
        Write-Log 'INFO' 'asar CLI missing, installing temp...'
        $tmp = Join-Path $env:TEMP 'lh-asar-cli'
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Push-Location $tmp
        & $NodeExe -e 'require("child_process").execSync("npm install @electron/asar --no-save",{stdio:"inherit"})'
        Pop-Location
        $asarCli = Join-Path $tmp 'node_modules\@electron\asar\bin\asar.mjs'
    }
    & $NodeExe $asarCli @AsarArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "asar $($AsarArgs -join ' ') failed (exit=$LASTEXITCODE)" }
}

# 判断当前 app.asar 是否已经包含 lyric-hub 注入
# 返回 $true = 已打过补丁；$false = 原版（可能被 M HUB 更新覆盖）
function Test-AsarHasMarker {
    param([string]$AsarFile)
    $asarLib = Join-Path $ProjectRoot 'node_modules\@electron\asar\lib\asar.js'
    if (-not (Test-Path $asarLib)) { return $false }
    $libEsc = $asarLib -replace '\\', '\\'
    $asarEsc = $AsarFile -replace '\\', '\\'
    $checkJs = @"
const asar = require('$libEsc');
try {
  const c = asar.extractFile('$asarEsc', '.\\out\\main\\index.js').toString('utf8');
  process.exit(c.indexOf('[lyric-hub]') >= 0 ? 0 : 1);
} catch (e) { process.exit(2); }
"@
    $checkFile = Join-Path $env:TEMP ('asar-check-' + [System.Guid]::NewGuid().ToString('N') + '.js')
    Set-Content -Path $checkFile -Value $checkJs -Encoding UTF8
    & $NodeExe $checkFile 2>&1 | Out-Null
    $code = $LASTEXITCODE
    Remove-Item $checkFile -Force -ErrorAction SilentlyContinue
    return ($code -eq 0)
}

# =============================================================
#                       INSTALL MODE
# =============================================================
function Do-Install {
    Write-Log 'STEP' '1/7 Locate MCHOSE HUB...'
    $appDir = Find-MHubDir
    if (-not $appDir) { Fatal 'MCHOSE HUB not found. Please install it first, or run MCHOSE HUB once.' }

    $asarPath   = Join-Path $appDir 'resources\app.asar'
    $moduleDest = Join-Path $appDir 'resources\app\lyric-hub'
    $backupPath = Join-Path $appDir 'resources\app.asar.lyric-hub-backup'

    Write-Log 'INFO' "  AppDir:  $appDir"
    Write-Log 'INFO' "  ASAR:    $asarPath"
    Write-Log 'INFO' "  Plugin:  $moduleDest"
    if (-not (Test-Path $asarPath)) { Fatal "app.asar missing: $asarPath" }

    Write-Log 'STEP' '2/7 Kill processes...'
    Kill-MchoseAll

    Write-Log 'STEP' '3/7 Backup app.asar...'
    # 只有当前 ASAR 还没有被本插件修改过，才把它作为“原版”备份。
    # 这样 M HUB 更新覆盖 app.asar 后，备份会同步刷新，卸载时不会把驱动降级成旧版本。
    $alreadyPatched = Test-AsarHasMarker $asarPath
    if (-not $alreadyPatched) {
        try {
            Copy-Item $asarPath $backupPath -Force
            Write-Log 'INFO' "  Backup refreshed -> $backupPath"
        } catch { Write-Log 'WARN' "  Backup failed: $($_.Exception.Message)" }
    } elseif (Test-Path $backupPath) {
        Write-Log 'INFO' '  当前 ASAR 已打过补丁，保留已有原版备份'
    } else {
        Write-Log 'WARN' '  当前 ASAR 已打过补丁但没有备份，卸载时需手动还原'
    }

    Write-Log 'STEP' '4/7 Copy plugin + backend files...'
    try {
        if (Test-Path $moduleDest) {
            try { Remove-Item $moduleDest -Recurse -Force -ErrorAction Stop }
            catch { & cmd /c "rmdir /S /Q `"$moduleDest`"" 2>&1 | Out-Null }
        }
        New-Item -ItemType Directory -Path $moduleDest -Force | Out-Null

        # ================================================================
        # 4a. 整个 lyric-hub/（含 backend 后端与 public Web UI）
        #     不复制 node_modules 与 package.json
        # ================================================================
        $pluginDir = Join-Path $ProjectRoot 'lyric-hub'
        if (-not (Test-Path $pluginDir)) { throw "lyric-hub/ not found: $pluginDir" }
        Get-ChildItem $pluginDir -Force | ForEach-Object {
            $item = $_
            $dst = Join-Path $moduleDest $item.Name
            if ($item.Name -eq 'package.json') { return }
            if ($item.Name -eq 'node_modules') { return }
            if ($item.PSIsContainer) {
                Copy-Item $item.FullName $dst -Recurse -Force
                Write-Log 'INFO' "  plugin dir +$($item.Name)/"
            } else {
                Copy-Item $item.FullName $dst -Force
                Write-Log 'INFO' "  plugin +$($item.Name)"
            }
        }
        # 本地运行缓存不属于安装包
        $dataDest = Join-Path $moduleDest 'backend\data'
        if (Test-Path $dataDest) { Remove-Item $dataDest -Recurse -Force -ErrorAction SilentlyContinue }

        # ================================================================
        # 4b. backend/node_modules（node-hid 等运行时依赖）
        #     排除仅安装器使用的 @electron/asar 与 @grpc
        # ================================================================
        $nmSrc = Join-Path $ProjectRoot 'node_modules'
        $nmDst = Join-Path $moduleDest 'backend\node_modules'
        if (Test-Path $nmSrc) {
            Write-Log 'INFO' '  backend +node_modules (~12MB)...'
            New-Item -ItemType Directory -Path $nmDst -Force | Out-Null
            Get-ChildItem $nmSrc -Force | ForEach-Object {
                $item = $_
                if ($item.Name -eq '@electron') { return }
                if ($item.Name -eq '@grpc') { return }
                if ($item.PSIsContainer) {
                    Copy-Item $item.FullName (Join-Path $nmDst $item.Name) -Recurse -Force
                } else {
                    # Skip .cmd/.ps1 helper scripts (installer-only)
                    if ($item.Extension -eq '.cmd') { return }
                    if ($item.Extension -eq '.ps1') { return }
                    Copy-Item $item.FullName (Join-Path $nmDst $item.Name) -Force
                }
            }
            Write-Log 'INFO' '  backend node_modules OK'
        } else {
            Write-Log 'WARN' '  node_modules missing - run: npm install'
        }

        # ================================================================
        # SAFETY: ensure NO package.json at lyric-hub root (breaks Electron ASAR)
        # BUT KEEP node_modules/**/package.json (each npm package needs its own!)
        # ================================================================
        Get-ChildItem $moduleDest -Recurse -Filter 'package.json' -ErrorAction SilentlyContinue | Where-Object {
            # Skip ANY package.json inside node_modules/
            $_.FullName -notmatch 'node_modules'
        } | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Log 'WARN' "  Removed stray package.json: $($_.FullName.Replace($moduleDest, ''))"
        }
        # Also remove package-lock.json (not needed at runtime, only installer)
        Get-ChildItem $moduleDest -Recurse -Filter 'package-lock.json' -ErrorAction SilentlyContinue | Where-Object {
            $_.FullName -notmatch 'node_modules'
        } | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }

        $fileCount = (Get-ChildItem $moduleDest -Recurse -File | Measure-Object).Count
        Write-Log 'INFO' "  Total: $fileCount files in lyric-hub/"
    } catch { Fatal "Copy plugin/backend failed: $($_.Exception.Message)" }

    Write-Log 'STEP' '5/7 Patch app.asar...'

    # 5a 不再用旧备份覆盖当前 ASAR：直接对当前版本解包 → 清理旧注入 → 重新注入。
    # （这样 M HUB 自动更新后，重装插件不会把驱动降级到备份时的旧版本。）
    Write-Log 'INFO' '  Patch current ASAR in place (strip old injection first)'

    $tmpExtract = Join-Path $env:TEMP ('asar-patch-' + [System.Guid]::NewGuid().ToString('N'))
    $newAsar = $asarPath + '.patched'

    try {
        # 5b extract
        Write-Log 'INFO' '  extract...'
        Invoke-Asar @('extract', $asarPath, $tmpExtract)
        Write-Log 'INFO' '  extract OK'

        # 5c patch
        Write-Log 'INFO' '  patch...'
        $idxPath = Join-Path $tmpExtract 'out\main\index.js'
        if (-not (Test-Path $idxPath)) { throw "out\main\index.js not found in ASAR" }

        # Read as bytes first to strip any BOM
        $idxBytes = [System.IO.File]::ReadAllBytes($idxPath)
        if ($idxBytes.Length -ge 3 -and $idxBytes[0] -eq 0xEF -and $idxBytes[1] -eq 0xBB -and $idxBytes[2] -eq 0xBF) {
            $idxBytes = $idxBytes[3..($idxBytes.Length-1)]
        }
        $content = [System.Text.Encoding]::UTF8.GetString($idxBytes)

        # Strip ALL lyric-hub related lines (clean any previous injection)
        $cleanedLines = ($content -split "`r?`n") | Where-Object {
            $_ -notmatch '\[lyric-hub\]' -and
            $_ -notmatch 'lyric-hub/index\.js'
        }
        $cleaned = $cleanedLines -join "`r`n"
        if (-not $cleaned.EndsWith("`r`n")) { $cleaned += "`r`n" }

        # Inject lyric-hub after "use strict"
        $inject = "try { require(require('path').join(process.resourcesPath,'app/lyric-hub/index.js')); } catch (e) { console.error('[lyric-hub] FAIL', e.message); }"
        if ($cleaned -match '^"use strict";\r?\n') {
            $m = [regex]::Match($cleaned, '^"use strict";\r?\n')
            $newContent = $m.Value + $inject + "`r`n" + $cleaned.Substring($m.Index + $m.Length)
        } else {
            $newContent = $inject + "`r`n" + $cleaned
        }

        # Write WITHOUT BOM (critical for Node.js ASAR relative require!)
        $noBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($idxPath, $newContent, $noBom)
        Write-Log 'INFO' '  patch OK (no BOM)'

        # Verify relative requires still intact
        $hasBytecode = $newContent -match '\.\/bytecode-loader\.cjs'
        $hasIndexJsc = $newContent -match '\.\/index\.jsc'
        Write-Log 'INFO' "  bytecode-loader.cjs=$hasBytecode  index.jsc=$hasIndexJsc"
        if (-not $hasBytecode -or -not $hasIndexJsc) { throw 'CRITICAL: relative requires broken!' }

        # 5d pack
        Write-Log 'INFO' '  pack...'
        if (Test-Path $newAsar) { Remove-Item $newAsar -Force }
        Invoke-Asar @('pack', $tmpExtract, $newAsar)
        Write-Log 'INFO' "  pack OK ($((Get-Item $newAsar).Length) bytes)"

        # 5d verify via Node API (CLI extract-file has capture issues with spaces)
        Write-Log 'INFO' '  verify (Node API)...'
        $verifyJs = @"
const asar = require('$((Join-Path $ProjectRoot 'node_modules\@electron\asar\lib\asar.js') -replace '\\','\\')');
const buf = asar.extractFile('$($newAsar -replace '\\','\\')', '.\\out\\main\\index.js');
const content = buf.toString('utf8');
console.log('VERIFY lyric-hub=' + content.includes('[lyric-hub]') + ' pet-hub=' + content.includes('pet-hub'));
if (!content.includes('[lyric-hub]')) { console.error('FAIL: lyric-hub not injected'); process.exit(1); }
"@
        $verifyJsFile = Join-Path $env:TEMP ('asar-verify-' + [System.Guid]::NewGuid().ToString('N') + '.js')
        Set-Content -Path $verifyJsFile -Value $verifyJs -Encoding UTF8
        $verifyOut = & $NodeExe $verifyJsFile 2>&1
        Write-Log 'INFO' "    $verifyOut"
        Remove-Item $verifyJsFile -Force -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "VERIFY FAILED: $verifyOut" }

        Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Log 'ERROR' "ASAR patch failed: $($_.Exception.Message)"
        Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
        Fatal 'ASAR patch error - see log'
    }

    Write-Log 'STEP' '6/7 Replace app.asar...'
    $replaced = $false
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            if (Test-Path $asarPath) {
                try { Remove-Item $asarPath -Force -ErrorAction Stop } catch {
                    Rename-Item $asarPath ($asarPath + '.old') -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 300
                    Remove-Item ($asarPath + '.old') -Force -ErrorAction SilentlyContinue
                }
            }
            Move-Item $newAsar $asarPath -Force
            $replaced = $true
            Write-Log 'INFO' "  Attempt $i OK"
            break
        } catch {
            Write-Log 'WARN' "  Attempt $i/15 failed: $($_.Exception.Message)"
            Start-Sleep -Seconds 1.5
        }
    }

    if (-not $replaced) {
        Write-Log 'ERROR' 'ASAR replace FAILED (file locked?)'
        Write-Log 'ERROR' "  Patched file at: $newAsar"
        Write-Log 'ERROR' '  Manual fix: close MCHOSE HUB -> rename app.asar -> copy .patched as app.asar'
        try { if ((Test-Path $backupPath) -and -not (Test-Path $asarPath)) { Copy-Item $backupPath $asarPath; Write-Log 'INFO' 'Restored backup' } } catch {}
        Fatal 'Install failed - ASAR locked'
    }

    Write-Log 'STEP' '7/7 Write manifest and launch...'
    try {
        $manifest = @{
            name        = 'lyric-hub'
            version     = '1.0.0'
            mode        = 'collab'
            installedAt = (Get-Date).ToString('o')
            appDir      = $appDir
            moduleDest  = $moduleDest
            backupPath  = $backupPath
        } | ConvertTo-Json -Depth 4
        Set-Content -Path (Join-Path $appDir 'lyric-hub-manifest.json') -Value $manifest -Encoding UTF8
        Write-Log 'INFO' '  manifest OK'
    } catch { Write-Log 'WARN' "  manifest write failed: $($_.Exception.Message)" }

    Launch-MHub -Dir $appDir

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  INSTALL COMPLETE' -ForegroundColor Green
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host "  Plugin dir: $moduleDest"
    Write-Host '  Play music -> K20 GT auto-lights lyrics'
    Write-Host '  Web UI: http://127.0.0.1:8720'
}

# =============================================================
#                       UNINSTALL MODE
# =============================================================
function Do-Uninstall {
    Write-Log 'STEP' '1/4 Locate MCHOSE HUB...'
    $appDir = Find-MHubDir
    if (-not $appDir) { Fatal 'MCHOSE HUB not found' }

    $asarPath   = Join-Path $appDir 'resources\app.asar'
    $moduleDest = Join-Path $appDir 'resources\app\lyric-hub'
    $backupPath = Join-Path $appDir 'resources\app.asar.lyric-hub-backup'
    Write-Log 'INFO' "  AppDir: $appDir"

    Write-Log 'STEP' '2/4 Kill processes...'
    Kill-MchoseAll

    Write-Log 'STEP' '3/4 Restore app.asar from backup...'
    $restored = $false
    if (-not (Test-Path $backupPath)) {
        Write-Log 'WARN' '  No lyric-hub backup found, skip ASAR restore'
    } elseif (-not (Test-AsarHasMarker $asarPath)) {
        Write-Log 'INFO' '  Current ASAR has no lyric-hub injection (M HUB may have updated), skip restore'
        $restored = $true
    } else {
        for ($i = 1; $i -le 15; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                if (Test-Path $asarPath) { Remove-Item $asarPath -Force -ErrorAction SilentlyContinue }
                Copy-Item $backupPath $asarPath -Force
                $restored = $true
                Write-Log 'INFO' "  Restored backup (attempt $i)"
                break
            } catch {
                Write-Log 'WARN' "  Attempt $i/15 failed: $($_.Exception.Message)"
                Start-Sleep -Seconds 1.5
            }
        }
    }

    Write-Log 'STEP' '4/4 Remove plugin files...'
    if (Test-Path $moduleDest) {
        try { Remove-Item $moduleDest -Recurse -Force -ErrorAction Stop; Write-Log 'INFO' '  lyric-hub dir removed' }
        catch { Write-Log 'WARN' '  Cannot delete lyric-hub dir - remove manually' }
    }
    $manifest = Join-Path $appDir 'lyric-hub-manifest.json'
    if (Test-Path $manifest) { Remove-Item $manifest -Force -ErrorAction SilentlyContinue }

    Launch-MHub -Dir $appDir

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    Write-Host '  UNINSTALL COMPLETE' -ForegroundColor Green
    Write-Host '========================================' -ForegroundColor Cyan
    if (-not $restored) { Write-Host '  WARNING: ASAR not restored - check app.asar' -ForegroundColor Yellow }
}

# =============================================================
#                       ENTRY
# =============================================================
try {
    if ($Mode -eq 'Uninstall') { Do-Uninstall } else { Do-Install }
} catch {
    Write-Log 'ERROR' "FATAL: $($_.Exception.Message)"
    Write-Log 'ERROR' $_.ScriptStackTrace
    Write-Host ''
    Write-Host 'Press any key to exit...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

Write-Host ''
Write-Host 'Press any key to exit...'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
