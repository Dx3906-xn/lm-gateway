# Start lm-gateway so that it survives the shell that started it.
#
# Why this file exists: the gateway was reported as "silently exiting mid-request with
# an empty stderr". It was not crashing. It had been started from a shell tool invocation
# with `Start-Process`, which makes that shell the parent; when the invocation ended, the
# whole process tree was reaped and the gateway went with it. The symptoms matched a
# crash exactly - the log simply stopped, nothing was thrown, nothing reached stderr -
# because from inside the process there is nothing to observe about being terminated.
#
# Measured on this machine: a process started with `Start-Process` was gone by the next
# tool call, while one created through WMI (whose parent is WmiPrvSE) survived
# indefinitely. So this hands the gateway to the WMI service host, whose lifetime is not
# tied to any interactive session.
#
# It also refuses to start a second copy: two gateways would fight over the same child
# services, and one's "stop" would kill the other's model mid-generation. The gateway
# itself holds a lock for that (src/heartbeat.js); this reports it plainly instead of
# letting the user discover it as a confusing failure.

$ErrorActionPreference = 'Stop'

$root = 'E:\B\lm-gateway'
$logDir = Join-Path $root 'output\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$outLog = Join-Path $logDir 'gateway.out.log'
$errLog = Join-Path $logDir 'gateway.err.log'

# Already running? Say which pid and stop, rather than fighting it.
$listening = Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue
if ($listening) {
    Write-Output "lm-gateway is already listening on 8790 (pid $($listening[0].OwningProcess))"
    exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Output 'node not found on PATH'
    exit 1
}

# A wrapper batch file rather than a quoted one-liner. The redirects, the working
# directory and the quoted paths all have to survive being passed through WMI to cmd,
# and building that as a single string is where quoting bugs live. A file sidesteps all
# of it, and doubles as a record of exactly what was launched.
$wrapper = Join-Path $logDir 'run-gateway.cmd'
$wrapperBody = @(
    '@echo off',
    "cd /d `"$root`"",
    "`"$node`" `"src/main.js`" > `"$outLog`" 2> `"$errLog`""
) -join "`r`n"
Set-Content -Path $wrapper -Value $wrapperBody -Encoding ASCII

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = "cmd.exe /c `"$wrapper`""
    CurrentDirectory = $root
}

if ($result.ReturnValue -ne 0) {
    Write-Output "failed to create the process (Win32_Process.Create returned $($result.ReturnValue))"
    exit 1
}

Write-Output "launching lm-gateway (launcher pid $($result.ProcessId)); parent is the WMI service host"

# Wait for it to bind, so a caller knows the difference between "started" and "ready".
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $bound = Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue
    if ($bound) {
        Write-Output "lm-gateway is up on http://127.0.0.1:8790 (pid $($bound[0].OwningProcess))"
        Write-Output 'webui: http://127.0.0.1:8790/'
        Write-Output "log:   $outLog"
        if (Test-Path $errLog) {
            $tail = Get-Content $errLog -Encoding UTF8 -Tail 5 -ErrorAction SilentlyContinue
            if ($tail) {
                Write-Output 'last warnings:'
                $tail | ForEach-Object { Write-Output "  $_" }
            }
        }
        exit 0
    }
}

Write-Output "lm-gateway did not bind 8790 within 30s; check $errLog and $outLog"
exit 1
