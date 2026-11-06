# K20 歌词引擎 - Windows 媒体会话（SMTC）监听
# 输出：每行一个 JSON，包含当前所有媒体会话的歌曲信息与播放进度

$Interval = 500
if ($env:K20_SMTC_INTERVAL) {
    $ms = 0
    if ([int]::TryParse($env:K20_SMTC_INTERVAL, [ref]$ms) -and $ms -ge 100) { $Interval = $ms }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(8000) | Out-Null
    return $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$manager = $null
for ($i = 0; $i -lt 10 -and $null -eq $manager; $i++) {
    try {
        $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if ($null -eq $manager) {
    Write-Output '{"ok":false,"error":"SMTC 初始化失败"}'
    exit 1
}

$mediaPropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

while ($true) {
    $now = [DateTimeOffset]::Now
    $sessions = @()
    try { $list = $manager.GetSessions() } catch { $list = @() }

    foreach ($s in $list) {
        try {
            $info = $s.GetPlaybackInfo()
            $status = ''
            if ($null -ne $info -and $null -ne $info.PlaybackStatus) { $status = $info.PlaybackStatus.ToString() }

            $title = ''
            $artist = ''
            $album = ''
            try {
                $props = Await ($s.TryGetMediaPropertiesAsync()) $mediaPropsType
                if ($null -ne $props) {
                    $title = [string]$props.Title
                    $artist = [string]$props.Artist
                    $album = [string]$props.AlbumTitle
                }
            } catch { }

            $pos = 0.0
            $dur = 0.0
            $lastUpdated = 0.0
            try {
                $tl = $s.GetTimelineProperties()
                if ($null -ne $tl) {
                    $pos = $tl.Position.TotalSeconds
                    $dur = $tl.EndTime.TotalSeconds
                    if ($null -ne $tl.LastUpdatedTime) {
                        # 统一输出为 epoch 毫秒，便于服务端与 Date.now() 直接比较
                        $lastUpdated = [double]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
                    }
                }
            } catch { }

            $sessions += [ordered]@{
                id         = [string]$s.SourceAppUserModelId
                app        = [string]$s.SourceAppUserModelId
                status     = $status
                title      = $title
                artist     = $artist
                album      = $album
                position   = [Math]::Round($pos, 2)
                duration   = [Math]::Round($dur, 2)
                lastUpdate = [Math]::Round($lastUpdated, 0)
            }
        } catch { }
    }

    $payload = [ordered]@{
        ok       = $true
        t        = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        sessions = $sessions
    }
    try {
        Write-Output ($payload | ConvertTo-Json -Compress -Depth 4)
    } catch { }

    try { Start-Sleep -Milliseconds $Interval } catch { [Console]::Error.WriteLine("sleep-err: $($_.Exception.Message)") }
}
