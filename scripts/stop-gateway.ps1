# Stop lm-gateway, and let it put the card back first.
#
# Order matters. The gateway owns child services that hold GBs of VRAM; killing it first
# would orphan them, and an orphaned ComfyUI holds ~5.7 GB with nothing left to reclaim
# it - measured once at 5817 MiB sitting resident until it was found by hand. So this
# asks the gateway to stop (SIGTERM, which its handler turns into "stop every child, then
# exit"), waits for the port to close, and only then forces the issue.
#
# The heartbeat file is what makes the difference visible afterwards: a clean stop rewrites
# it with `cleanExit: true`, so the next start stays quiet. If this is bypassed with a hard
# kill, the next start reports an unclean shutdown with the last recorded activity.

$ErrorActionPreference = 'Continue'

$root = 'E:\B\lm-gateway'
$timeoutSec = 45

$listening = Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Output 'lm-gateway is not listening on 8790'
    exit 0
}

$owner = [int]$listening[0].OwningProcess
Write-Output "asking lm-gateway (pid $owner) to stop; it will stop its child services first"

# Windows has no SIGTERM for GUI-less processes; Stop-Process is a terminate, so the
# graceful path is the HTTP route the gateway exposes for exactly this.
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/shutdown' -Method POST -TimeoutSec 10 | Out-Null
} catch {
    # An endpoint that is not there yet, or a gateway too busy to answer: fall through
    # to the bounded wait, then the forced kill.
    Write-Output 'no /api/shutdown answer; waiting then forcing'
}

$deadline = (Get-Date).AddSeconds($timeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue)) {
        Write-Output 'lm-gateway stopped cleanly'
        exit 0
    }
}

Write-Output "still listening after ${timeoutSec}s; terminating"
$still = Get-Process -Id $owner -ErrorAction SilentlyContinue
if ($still) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if (Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue) {
    Write-Output 'WARNING: 8790 is still held; check for a second gateway'
    exit 1
}

Write-Output 'lm-gateway terminated (unclean: child services may still be resident)'
Write-Output 'run E:\B\scripts\stop_services.ps1 to reclaim their VRAM'
exit 0
