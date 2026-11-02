#Requires -Version 5.1
# The Windows login task of tf-hostd ("Bring agents back after a reboot"), checked on a real PC: the
# GitHub Windows runner of .github/workflows/login-items.yml. No real Task Scheduler had run
# against it before; this does, and a failed check says which one and why.
#
# The runner is a disposable VM, so the real home (%USERPROFILE%\.teleflock) is used: it is the one
# home that installs a login task (automations/boot.rs allows no other). The script therefore
# refuses to run anywhere but a GitHub runner, and where that folder already has files in it.
# (This file is ASCII only: Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI.)
#
#   deploy  the built tf-hostd.exe goes to ~\.teleflock\bin\tf-hostd.exe, where the app puts it.
#   seed    ledger.json gets one agent that a reboot ended. A fresh home has no agents and no
#           automations, and then nothing is installed (there is nothing to bring back); this is the
#           entry a real agent leaves behind. herdr is not installed on the runner: nothing is relaunched.
#   (a)     `tf-hostd attach` (what the app runs) starts the daemon and, with no setting touched, the
#           task "TeleFlock host service <hash>" appears: `schtasks /Query /TN <name>` finds it, its
#           XML has the logon trigger (this user, 1 min delay, repeating every 10 min), the principal
#           (this user's SID, InteractiveToken, LeastPrivilege) and the action (the launcher, `ensure`),
#           and host.autoResume says installed.
#   (b)     the daemon is killed by PID (checked) and stays down; `schtasks /Run` brings it back within
#           60 s and it answers a status call.
#   (c)     the launcher tf-hostd-login.exe is tf-hostd.exe with one header byte changed to the GUI
#           subsystem; while the task runs, no conhost.exe starts for the launcher or for the daemon it
#           starts (a trace of every process start, parent and child), and the daemon runs from the real
#           tf-hostd.exe. A throwaway task that runs a console program (ping.exe) is the control: it
#           shows conhost.exe does appear for one, so the trace could have caught it.
#   (d)     host.autoResumeSet {bringBack:false} (Settings -> Auto-resume) deletes the task and its files.
#   (e)     host.autoResumeSet {bringBack:true} creates it again, and the new task starts the daemon too.
#   (f)     logs: everything in $LOGIN_ITEMS_LOGS (default $RUNNER_TEMP\login-items-logs), whatever happens.
#
# Not proved: that Windows fires the logon trigger at a real logon or after a reboot (the XML is
# checked and the task is run by hand), what a PC without an interactive session (a service account)
# does, other Windows versions. The runner is whichever Windows it is today (the version is in the log).
#
# Usage: pwsh -File scripts/ci/login-items-windows.ps1 [-Hostd <built tf-hostd.exe>] [-LogDir <dir>] [-WaitSeconds 60]
# Env:   TF_HOSTD_BIN, LOGIN_ITEMS_LOGS, LOGIN_ITEMS_WAIT (the defaults of the parameters; the binary's is
#        target\release\tf-hostd.exe); LOGIN_ITEMS_ON_DISPOSABLE_HOST=1 allows it outside a GitHub-hosted runner
#        (it replaces what is under ~\.teleflock, and removes its login task).
# Exit:  0 every check passed, 1 a check failed, 64 refused to run here.

[CmdletBinding()]
param(
    [string]$Hostd = $(if ($env:TF_HOSTD_BIN) { $env:TF_HOSTD_BIN } else { 'target\release\tf-hostd.exe' }),
    [string]$LogDir = $(if ($env:LOGIN_ITEMS_LOGS) { $env:LOGIN_ITEMS_LOGS } else { Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }) 'login-items-logs' }),
    [int]$WaitSeconds = $(if ($env:LOGIN_ITEMS_WAIT) { [int]$env:LOGIN_ITEMS_WAIT } else { 60 })
)

Set-StrictMode -Version 2.0
# Native tools write to stderr as they like; nothing here may turn that into a terminating error.
$ErrorActionPreference = 'Continue'

$script:ExeName = 'tf-hostd.exe'
$script:LauncherName = 'tf-hostd-login.exe'
$script:TaskPrefix = 'TeleFlock host service '
$script:ControlTask = 'TeleFlock CI console control'
$script:TraceId = 'TfLoginItemsProcessStart'
$script:ConsoleHosts = @('conhost.exe', 'OpenConsole.exe', 'WindowsTerminal.exe')

$script:Results = New-Object 'System.Collections.Generic.List[object]'
$script:Facts = New-Object 'System.Collections.Generic.List[string]'
$script:Failures = 0
$script:Waited = 0
$script:TaskName = $null
$script:Call = $null
$script:OldPid = 0
$script:NewPid = 0
$script:Finished = $false
$script:ExitCode = 1 # until Complete-Run says otherwise
$script:Refused = $false

# -- output -----------------------------------------------------------------------------------------
function Test-OnActions { return ($env:GITHUB_ACTIONS -eq 'true') }
function Write-Group([string]$Title) { if (Test-OnActions) { Write-Host "::group::$Title" } else { Write-Host "== $Title" } }
function Write-EndGroup { if (Test-OnActions) { Write-Host '::endgroup::' } }

# One line that is safe in a workflow command message (the runner unescapes %, CR and LF).
function Format-OneLine([string]$Text, [int]$Max = 600) {
    $t = ($Text -replace '%', '%25') -replace '[\r\n]+', ' '
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) }
    return $t
}
function Format-Property([string]$Text) { return (($Text -replace '[:,\r\n]', '')).Trim() }

function Add-Pass([string]$Name) {
    $script:Results.Add([pscustomobject]@{ Ok = $true; Text = $Name })
    Write-Host "PASS  $Name"
}
function Add-Fail([string]$Name, [string]$Why) {
    $script:Failures++
    $script:Results.Add([pscustomobject]@{ Ok = $false; Text = "$Name - $Why" })
    Write-Host "FAIL  $Name - $Why"
    if (Test-OnActions) { Write-Host "::error title=login task $(Format-Property $Name)::$(Format-OneLine $Why)" }
    $log = Join-Path $script:HostdHome 'hostd.log'
    if (Test-Path -LiteralPath $log) {
        Write-Host '--- the end of hostd.log'
        Get-Content -LiteralPath $log -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_.Substring(0, [Math]::Min($_.Length, 300)) }
        Write-Host '---'
    }
}
function Add-Fact([string]$Text) {
    $script:Facts.Add($Text)
    Write-Host "info  $Text"
}
function Add-Warning([string]$Title, [string]$Text) {
    Add-Fact "WARNING: $Text"
    if (Test-OnActions) { Write-Host "::warning title=$(Format-Property $Title)::$(Format-OneLine $Text)" }
}
function Get-Slug([string]$Text) { return (($Text.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')) }
function Save-Text([string]$Name, [string]$Text) {
    try { Set-Content -LiteralPath (Join-Path $LogDir $Name) -Value $Text -Encoding UTF8 } catch { Write-Host "cannot write ${Name}: $($_.Exception.Message)" }
}

# Wait-Until { condition }: polls once a second until the block returns true. $script:Waited = seconds spent.
function Wait-Until([scriptblock]$Condition, [int]$TimeoutSec = $WaitSeconds, [int]$PollMs = 1000) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        if ([bool](& $Condition)) { $script:Waited = [int][Math]::Round($clock.Elapsed.TotalSeconds); return $true }
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSec) { $script:Waited = [int][Math]::Round($clock.Elapsed.TotalSeconds); return $false }
        Start-Sleep -Milliseconds $PollMs
    }
}

# A member of a parsed JSON document by dotted path; $null when anything on the way is missing.
function Get-JsonMember($Object, [string]$Path) {
    $cur = $Object
    foreach ($key in $Path.Split('.')) {
        if ($null -eq $cur) { return $null }
        $prop = $cur.PSObject.Properties[$key]
        if ($null -eq $prop) { return $null }
        $cur = $prop.Value
    }
    return $cur
}

# automations' name for a home (paths.rs `home_hash`): FNV-1a, 32 bits, over the UTF-8 bytes.
function Get-Fnv1a([string]$Text) {
    $mask = [uint64]4294967295
    $h = [uint64]2166136261
    foreach ($b in [System.Text.Encoding]::UTF8.GetBytes($Text)) {
        $h = (($h -bxor [uint64]$b) * [uint64]16777619) -band $mask
    }
    return ('{0:x8}' -f [uint32]$h)
}

# -- native tools -----------------------------------------------------------------------------------
# One argument as CommandLineToArgvW reads it back.
function ConvertTo-Argument([string]$Argument) {
    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }
    $escaped = $Argument -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}
function ConvertTo-ArgumentString([string[]]$Arguments) { return (($Arguments | ForEach-Object { ConvertTo-Argument $_ }) -join ' ') }

# Runs a short-lived tool, with a time limit: @{ ExitCode; Out; Err }. Not for anything that starts a
# daemon (a daemon inherits the pipes, and the pipes then never end): see Invoke-Wire.
function Invoke-Native([string]$File, [string[]]$Arguments = @(), [int]$TimeoutSec = 60) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = ConvertTo-ArgumentString $Arguments
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    try { $proc = [System.Diagnostics.Process]::Start($info) } catch { return [pscustomobject]@{ ExitCode = -1; Out = ''; Err = "cannot run ${File}: $($_.Exception.Message)" } }
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { Write-Verbose 'already gone' }
        return [pscustomobject]@{ ExitCode = -1; Out = ''; Err = "$File timed out after $TimeoutSec s" }
    }
    $null = $out.Wait(5000)
    $null = $err.Wait(5000)
    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        Out = $(if ($out.IsCompleted) { $out.Result } else { '' })
        Err = $(if ($err.IsCompleted) { $err.Result } else { '' })
    }
}

function Get-SchtasksPath {
    $root = if ($env:SystemRoot) { $env:SystemRoot.TrimEnd('\') } else { 'C:\Windows' }
    return (Join-Path (Join-Path $root 'System32') 'schtasks.exe')
}
function Invoke-Schtasks([string[]]$Arguments, [int]$TimeoutSec = 60) { return (Invoke-Native (Get-SchtasksPath) $Arguments $TimeoutSec) }

# -- the daemon, through the wire helper ------------------------------------------------------------
# A Python 3 on PATH that runs (not the Microsoft Store's stub in WindowsApps, which opens the Store).
function Find-Python {
    foreach ($name in @('python', 'python3', 'py')) {
        foreach ($cmd in @(Get-Command $name -All -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -notmatch '\\WindowsApps\\' })) {
            $v = Invoke-Native $cmd.Source @('--version') 20
            if ($v.ExitCode -eq 0 -and ($v.Out + $v.Err) -match 'Python 3') { return $cmd.Source }
        }
    }
    return $null
}

# A text file as a string: '' for a missing or an empty one. Opened for sharing in every way: the daemon
# `attach` started may have inherited the handle the file was redirected through, and still holds it.
function Read-TextFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    } finally { $stream.Dispose() }
}

# hostd-wire.py, with its output in files: the daemon attach starts inherits attach's handles, so a
# pipe to this script would not end while the daemon lives.
function Invoke-Wire([string[]]$WireArguments, [int]$TimeoutSec = 150) {
    $stem = 'wire-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $outFile = Join-Path $LogDir "$stem.out"
    $errFile = Join-Path $LogDir "$stem.err"
    $argumentString = ConvertTo-ArgumentString (@($script:Wire, $script:Bin, '--timeout', '90') + $WireArguments)
    $proc = Start-Process -FilePath $script:Python -ArgumentList $argumentString -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $null = $proc.Handle
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { Write-Verbose 'already gone' }
    }
    $proc.WaitForExit(2000) | Out-Null
    $out = Read-TextFile $outFile
    $err = Read-TextFile $errFile
    Add-Content -LiteralPath (Join-Path $LogDir 'wire-calls.txt') -Value ("{0} -> {1}`n{2}" -f ($WireArguments -join ' '), $out.Trim(), $err.Trim())
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    $code = if ($proc.HasExited) { $proc.ExitCode } else { -1 }
    return [pscustomobject]@{ ExitCode = $code; Out = $out.Trim(); Err = $err.Trim() }
}

# One request through `tf-hostd attach` (it starts a daemon when none runs, so only where one is expected).
# $script:Call = the reply message, parsed.
function Invoke-WireCall([string]$Method, [string]$ParamsJson = '') {
    $wireArguments = @('call', $Method)
    if ($ParamsJson) {
        $paramsFile = Join-Path $LogDir ('params-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
        [System.IO.File]::WriteAllText($paramsFile, $ParamsJson, (New-Object System.Text.UTF8Encoding($false)))
        $wireArguments += "@$paramsFile"
    }
    $r = Invoke-Wire $wireArguments
    if ($ParamsJson) { Remove-Item -LiteralPath $paramsFile -Force -ErrorAction SilentlyContinue }
    $script:Call = $null
    if ($r.Out) { try { $script:Call = $r.Out | ConvertFrom-Json } catch { Write-Verbose 'not JSON' } }
    $r | Add-Member -NotePropertyName Message -NotePropertyValue $r.Out -Force
    return $r
}
function Test-CallOk($Reply) { return ($Reply.ExitCode -eq 0 -and $null -ne $script:Call -and $null -eq (Get-JsonMember $script:Call 'error')) }

# The control reply of the running daemon: its pid, relay port, home; $null when it did not answer.
function Get-DaemonInfo {
    $r = Invoke-Wire @('info')
    if ($r.ExitCode -ne 0 -or -not $r.Out) { return $null }
    try { $reply = $r.Out | ConvertFrom-Json } catch { return $null }
    $daemonPid = Get-JsonMember $reply 'pid'
    if ($null -eq $daemonPid) { return $null }
    return [pscustomobject]@{ Pid = [int]$daemonPid; RelayPort = (Get-JsonMember $reply 'relayPort'); Home = (Get-JsonMember $reply 'home'); Raw = $r.Out }
}

function Get-BootServiceState {
    $r = Invoke-WireCall 'host.autoResume'
    if (-not (Test-CallOk $r)) { return $null }
    return (Get-JsonMember $script:Call 'result.bootService')
}
function Test-BootServiceInstalled { $s = Get-BootServiceState; return ($null -ne $s -and (Get-JsonMember $s 'installed') -eq $true) }
function Test-BootServiceGone { $s = Get-BootServiceState; return ($null -ne $s -and (Get-JsonMember $s 'installed') -eq $false) }

# The processes of this home's daemon (`tf-hostd.exe daemon ...`, or the launcher's copy of it): never
# asks the daemon, so it never starts one.
function Get-DaemonProcesses {
    $found = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'tf-hostd.exe' OR Name = 'tf-hostd-login.exe'" -ErrorAction SilentlyContinue
    return @($found | Where-Object { $_.CommandLine -match '(^|\s)daemon(\s|$)' } | ForEach-Object {
        [pscustomobject]@{ Pid = [int]$_.ProcessId; ParentPid = [int]$_.ParentProcessId; Name = [string]$_.Name; Path = [string]$_.ExecutablePath; CommandLine = [string]$_.CommandLine }
    })
}
function Test-ProcessAlive([int]$ProcessId) { return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) }
function Stop-DaemonProcess([int]$ProcessId) { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
function Test-SamePath([string]$A, [string]$B) { return ([string]::Equals($A.TrimEnd('\'), $B.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) }

# -- the task ---------------------------------------------------------------------------------------
# The tasks of TeleFlock's naming that exist (schtasks lists them with a leading backslash).
function Get-TeleFlockTasks {
    $r = Invoke-Schtasks @('/Query', '/FO', 'CSV', '/NH')
    if ($r.ExitCode -ne 0) { return @() }
    return @($r.Out -split "`r?`n" | Where-Object { $_ -and $_.Contains($script:TaskPrefix) } | ForEach-Object { ($_ | ConvertFrom-Csv -Header 'TaskName', 'NextRun', 'Status').TaskName.TrimStart('\') } | Where-Object { $_.StartsWith($script:TaskPrefix) })
}
function Find-Task {
    $tasks = @(Get-TeleFlockTasks)
    if ($tasks.Count -eq 1) { $script:TaskName = $tasks[0]; return $true }
    return $false
}
function Test-TaskLoaded { return ($null -ne $script:TaskName -and (Invoke-Schtasks @('/Query', '/TN', $script:TaskName)).ExitCode -eq 0) }
function Test-TaskGone { return (@(Get-TeleFlockTasks).Count -eq 0) }
function Test-FilesGone { return (-not (Test-Path -LiteralPath $script:XmlFile) -and -not (Test-Path -LiteralPath $script:Launcher)) }
function Test-TaskInstalled { return ((Find-Task) -and (Test-Path -LiteralPath $script:XmlFile) -and (Test-Path -LiteralPath $script:Launcher)) }

function Get-TaskXml([string]$Name) {
    $r = Invoke-Schtasks @('/Query', '/TN', $Name, '/XML')
    if ($r.ExitCode -eq 0 -and $r.Out -match '<Task') { return (($r.Out -replace "`0", '').TrimStart([char]0xFEFF, ' ', "`r", "`n")) }
    try { return [string](Export-ScheduledTask -TaskName $Name -ErrorAction Stop) } catch { return $null }
}

function Resolve-Sid([string]$Id) {
    if ($Id -match '^S-1-') { return $Id }
    try { return (New-Object System.Security.Principal.NTAccount($Id)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}

# What the task XML must say (automations/schtasks.rs `render`): a list of what is wrong, empty when nothing.
# Task Scheduler may leave out an element whose value is the schema's default when it exports the task
# (a missing one then counts as that default), and may quote the command.
function Test-TaskXml([string]$Xml, [string]$Sid, [string]$Launcher, [string]$Arguments) {
    $problems = New-Object 'System.Collections.Generic.List[string]'
    $doc = New-Object System.Xml.XmlDocument
    try { $doc.LoadXml($Xml) } catch { return @("the task XML does not parse: $($_.Exception.Message)") }
    $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $text = {
        param([string]$XPath)
        $node = $doc.SelectSingleNode($XPath, $ns)
        if ($null -eq $node) { return $null }
        return $node.InnerText.Trim()
    }
    $expect = {
        param([string]$What, [string]$XPath, [string]$Want, [bool]$IgnoreCase, [string]$Default = '')
        $got = & $text $XPath
        if ($null -eq $got) {
            if ($Default -ne '' -and [string]::Equals($Default, $Want, [System.StringComparison]::OrdinalIgnoreCase)) { return }
            $problems.Add("$What is missing ($XPath)")
            return
        }
        if ($XPath.EndsWith('/t:Command')) { $got = $got.Trim('"') }
        $same = if ($IgnoreCase) { [string]::Equals($got, $Want, [System.StringComparison]::OrdinalIgnoreCase) } else { $got -ceq $Want }
        if (-not $same) { $problems.Add("$What is '$got', expected '$Want'") }
    }
    $triggers = $doc.SelectNodes('//t:Triggers/t:LogonTrigger', $ns)
    if ($triggers.Count -ne 1) { $problems.Add("expected one LogonTrigger, found $($triggers.Count)") }
    $allTriggers = $doc.SelectNodes('//t:Triggers/*', $ns)
    if ($allTriggers.Count -ne 1) { $problems.Add("expected only the logon trigger, found $($allTriggers.Count) triggers") }
    & $expect 'the logon trigger delay' '//t:LogonTrigger/t:Delay' 'PT1M' $false
    & $expect 'the logon trigger repetition' '//t:LogonTrigger/t:Repetition/t:Interval' 'PT10M' $false
    & $expect 'the repetition ends' '//t:LogonTrigger/t:Repetition/t:StopAtDurationEnd' 'false' $true 'false'
    & $expect 'the logon trigger enabled' '//t:LogonTrigger/t:Enabled' 'true' $true 'true'
    & $expect 'the logon type' '//t:Principals/t:Principal/t:LogonType' 'InteractiveToken' $false
    & $expect 'the run level' '//t:Principals/t:Principal/t:RunLevel' 'LeastPrivilege' $false 'LeastPrivilege'
    & $expect 'the action command' '//t:Actions/t:Exec/t:Command' $Launcher $true
    & $expect 'the action arguments' '//t:Actions/t:Exec/t:Arguments' $Arguments $false
    & $expect 'multiple instances' '//t:Settings/t:MultipleInstancesPolicy' 'IgnoreNew' $false 'IgnoreNew'
    & $expect 'the execution time limit' '//t:Settings/t:ExecutionTimeLimit' 'PT0S' $false
    & $expect 'start on batteries' '//t:Settings/t:DisallowStartIfOnBatteries' 'false' $true
    & $expect 'stop on batteries' '//t:Settings/t:StopIfGoingOnBatteries' 'false' $true
    foreach ($place in @(@('the logon trigger user', '//t:LogonTrigger/t:UserId'), @('the principal user', '//t:Principals/t:Principal/t:UserId'))) {
        $id = & $text $place[1]
        if ($null -eq $id) { $problems.Add("$($place[0]) is missing"); continue }
        $resolved = Resolve-Sid $id
        if ($null -eq $resolved) { $problems.Add("$($place[0]) '$id' is no account that can be resolved") }
        elseif ($resolved -ne $Sid) { $problems.Add("$($place[0]) is '$id' ($resolved), expected this user ($Sid)") }
    }
    return $problems.ToArray()
}

# -- the launcher: a PE file -----------------------------------------------------------------------
# What a Windows program says about itself: IsPe, and its subsystem (2 GUI, 3 console) with the file
# offset of that field (the byte the launcher differs in).
function Get-PeInfo([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = New-Object byte[] 65536
        $read = $stream.Read($buffer, 0, $buffer.Length)
    } finally { $stream.Dispose() }
    if ($read -lt 0x40 -or $buffer[0] -ne 0x4D -or $buffer[1] -ne 0x5A) { return [pscustomobject]@{ IsPe = $false; Subsystem = 0; Offset = 0 } }
    $header = [BitConverter]::ToInt32($buffer, 0x3C)
    if ($header -lt 0 -or $header + 24 + 70 -gt $read) { return [pscustomobject]@{ IsPe = $false; Subsystem = 0; Offset = 0 } }
    if ($buffer[$header] -ne 0x50 -or $buffer[$header + 1] -ne 0x45 -or $buffer[$header + 2] -ne 0 -or $buffer[$header + 3] -ne 0) { return [pscustomobject]@{ IsPe = $false; Subsystem = 0; Offset = 0 } }
    $offset = $header + 24 + 68
    return [pscustomobject]@{ IsPe = $true; Subsystem = [int][BitConverter]::ToUInt16($buffer, $offset); Offset = $offset }
}

# The SHA-256 of `Path` with the byte at Offset set to Value (a copy in memory): what the launcher must be.
function Get-PatchedHash([string]$Path, [int]$Offset, [byte]$Value) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $bytes[$Offset] = $Value
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}
function Get-FileSha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $stream.Dispose(); $sha.Dispose() }
}

# -- a trace of every process start -----------------------------------------------------------------
$script:TraceOn = $false
# What the control (Invoke-ConsoleControl) found out on this runner: a console host started for a
# console program that Task Scheduler ran (TraceTrusted: the trace can see one), and as a child of that
# program (ConsoleParentIsClient: a console host can be told apart by its parent, as on Windows 10 and later).
$script:TraceTrusted = $false
$script:ConsoleParentIsClient = $false
# Without a trace: the processes seen by polling the process table (pid -> @{ Name; Pid; ParentPid }).
$script:Sampling = $false
$script:Sampled = @{}

function Start-ProcessTrace {
    $script:TraceOn = $false
    try {
        Get-EventSubscriber -SourceIdentifier $script:TraceId -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
        Get-Event -SourceIdentifier $script:TraceId -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
        $null = Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $script:TraceId -ErrorAction Stop
        $script:TraceOn = $true
    } catch { Add-Fact "no trace of process starts on this runner ($($_.Exception.Message)): the process table is polled instead" }
    return $script:TraceOn
}
# Every start since Start-ProcessTrace, in order: @{ Name; Pid; ParentPid }.
function Read-ProcessTrace {
    if (-not $script:TraceOn) { return @() }
    return @(Get-Event -SourceIdentifier $script:TraceId -ErrorAction SilentlyContinue | ForEach-Object {
        $e = $_.SourceEventArgs.NewEvent
        [pscustomobject]@{ Name = [string]$e.ProcessName; Pid = [int]$e.ProcessID; ParentPid = [int]$e.ParentProcessID }
    })
}
function Stop-ProcessTrace {
    if (-not $script:TraceOn) { return }
    Get-EventSubscriber -SourceIdentifier $script:TraceId -ErrorAction SilentlyContinue | Unregister-Event -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $script:TraceId -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    $script:TraceOn = $false
}
# One look at the process table, added to what was seen before (the fallback when no trace can be had).
function Add-ProcessSample {
    foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
        $id = [int]$p.ProcessId
        if (-not $script:Sampled.ContainsKey($id)) {
            $script:Sampled[$id] = [pscustomobject]@{ Name = [string]$p.Name; Pid = $id; ParentPid = [int]$p.ParentProcessId }
        }
    }
}
function Save-ProcessTrace([string]$Name, $Events) {
    Save-Text $Name (($Events | ForEach-Object { '{0,8} <- {1,-8} {2}' -f $_.Pid, $_.ParentPid, $_.Name }) -join "`n")
}

# The pids of `Roots` and of everything they started, by the parents in `Events`.
function Get-Descendants($Events, [int[]]$Roots) {
    $set = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($root in $Roots) { [void]$set.Add($root) }
    do {
        $grew = $false
        foreach ($e in $Events) { if ($set.Contains($e.ParentPid) -and $set.Add($e.Pid)) { $grew = $true } }
    } while ($grew)
    return [int[]]@($set)
}

# What one run of the task shows (c): the launcher ran, it started the daemon, and no console host was
# started for the launcher, the daemon or anything they started. `Strict`: a console host cannot be told
# apart by its parent on this runner, so any that starts after the launcher counts. `Sampled`: Events
# come from polling, which may have missed the short-lived launcher (that is no problem then).
function Test-LaunchTrace($Events, [int]$DaemonPid, [bool]$Strict, [bool]$Sampled) {
    $problems = New-Object 'System.Collections.Generic.List[string]'
    $all = @($Events)
    $first = -1
    for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i].Name -ieq $script:LauncherName) { $first = $i; break } }
    if ($first -lt 0 -and -not $Sampled) {
        $problems.Add("no start of $($script:LauncherName) in the trace: the task did not run the launcher")
        return $problems.ToArray()
    }
    $after = if ($first -ge 0) { @($all[$first..($all.Count - 1)]) } else { $all }
    $launcherPids = @($after | Where-Object { $_.Name -ieq $script:LauncherName } | ForEach-Object { $_.Pid })
    $mine = @(Get-Descendants $after (@($launcherPids) + @($DaemonPid)))
    $daemonStart = @($after | Where-Object { $_.Pid -eq $DaemonPid } | Select-Object -First 1)
    if ($daemonStart.Count -eq 1 -and $launcherPids.Count -gt 0 -and ($launcherPids -notcontains $daemonStart[0].ParentPid)) {
        $problems.Add("the daemon (pid $DaemonPid) was started by pid $($daemonStart[0].ParentPid), not by the launcher ($($launcherPids -join ', '))")
    }
    foreach ($c in @($after | Where-Object { $script:ConsoleHosts -contains $_.Name })) {
        if ($mine -contains $c.ParentPid) {
            $problems.Add("$($c.Name) (pid $($c.Pid)) was started for pid $($c.ParentPid), a process of the launcher or the daemon: a console window")
        } elseif ($Strict -and -not $Sampled) {
            $problems.Add("$($c.Name) (pid $($c.Pid), parent pid $($c.ParentPid)) was started while the launcher and the daemon started, and on this runner a console host cannot be told from theirs by its parent")
        }
    }
    return $problems.ToArray()
}

# -- preflight, deploy, seed ------------------------------------------------------------------------
function Stop-Refused([string]$Message) {
    [Console]::Error.WriteLine("login-items-windows: $Message")
    $script:Refused = $true
    exit 64
}

function Initialize-State {
    $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    # Only the default home installs a login task (automations/boot.rs): a TF_HOSTD_HOME in the
    # environment would make the daemon and `attach` use another home and install none.
    Remove-Item -LiteralPath Env:TF_HOSTD_HOME -ErrorAction SilentlyContinue
    $script:HostdHome = Join-Path $userHome '.teleflock'
    $script:BinDir = Join-Path $script:HostdHome 'bin'
    $script:Bin = Join-Path $script:BinDir $script:ExeName
    $script:Launcher = Join-Path $script:BinDir $script:LauncherName
    $script:XmlFile = Join-Path $script:HostdHome 'login-task.xml'
    $script:ExpectedTask = $script:TaskPrefix + (Get-Fnv1a $script:HostdHome)
    $script:Wire = Join-Path $PSScriptRoot 'hostd-wire.py'
    $script:Python = Find-Python
    $script:Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Assert-Preflight {
    $override = ($env:LOGIN_ITEMS_ON_DISPOSABLE_HOST -eq '1')
    if (-not $override -and -not (Test-OnActions)) {
        Stop-Refused "it installs and removes a real login task and stops the real tf-hostd of $($script:HostdHome): it is meant for the disposable GitHub runner. Set LOGIN_ITEMS_ON_DISPOSABLE_HOST=1 to run it on a machine you can lose that on."
    }
    if (-not $override -and $env:RUNNER_ENVIRONMENT -eq 'self-hosted') {
        Stop-Refused 'this is a self-hosted runner, somebody''s own machine: set LOGIN_ITEMS_ON_DISPOSABLE_HOST=1 if it is one that can lose its login task and its tf-hostd.'
    }
    if (-not $override -and (Test-Path -LiteralPath $script:HostdHome) -and @(Get-ChildItem -LiteralPath $script:HostdHome -Force -ErrorAction SilentlyContinue).Count -gt 0) {
        Stop-Refused "$($script:HostdHome) is not empty: this is not a fresh runner, so it is left alone."
    }
    if (-not (Test-Path -LiteralPath $Hostd)) { Stop-Refused "$Hostd is not there (the built tf-hostd.exe): pass its path." }
    if (-not $script:Python) { Stop-Refused 'no python on PATH (scripts/ci/hostd-wire.py needs it).' }
    # Nothing is cleaned up after a refusal, so every check that a machine is not the disposable one this needs
    # comes here: no TeleFlock login task may exist before the daemon ever ran.
    if (@(Get-TeleFlockTasks).Count -ne 0) { Stop-Refused 'a TeleFlock login task exists before the daemon ever ran: this is not a fresh runner, so it is left alone.' }
}

function Write-Machine {
    Write-Group 'the machine'
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $note = { param([string]$Title, $Text) $lines.Add("--- $Title"); $lines.Add([string]$Text) }
    & $note 'Windows' "$([System.Environment]::OSVersion.VersionString) / $((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption)"
    & $note 'PowerShell' $PSVersionTable.PSVersion.ToString()
    & $note 'user' "$env:USERNAME, SID $($script:Sid), session id $([System.Diagnostics.Process]::GetCurrentProcess().SessionId)"
    & $note 'quser (an interactive session is what the task needs)' ((Invoke-Native 'quser.exe' @() 20) | ForEach-Object { $_.Out + $_.Err })
    & $note 'whoami /groups (elevated?)' ((Invoke-Native 'whoami.exe' @('/groups') 20).Out -split "`n" | Where-Object { $_ -match 'Mandatory Label' })
    & $note 'Task Scheduler service' ((Get-Service -Name Schedule -ErrorAction SilentlyContinue | Out-String).Trim())
    $history = Invoke-Native 'wevtutil.exe' @('sl', 'Microsoft-Windows-TaskScheduler/Operational', '/e:true') 30
    & $note 'Task Scheduler operational log switched on' "exit $($history.ExitCode) $($history.Err)"
    & $note 'python' ((Invoke-Native $script:Python @('--version') 20) | ForEach-Object { $_.Out + $_.Err })
    & $note 'binary under test' "$Hostd, $((Get-Item -LiteralPath $Hostd).Length) bytes"
    & $note 'home under test' "$($script:HostdHome), so the task should be '$($script:ExpectedTask)'"
    $text = $lines -join "`n"
    Save-Text 'machine.txt' $text
    Write-Host $text
    Write-EndGroup
    if ([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        Add-Warning 'session 0' 'this job runs in session 0: a task for the interactive user may have no session to run in'
    }
}

function Install-Binary {
    Write-Group 'deploy tf-hostd like the app does, seed the agent ledger'
    New-Item -ItemType Directory -Force -Path $script:BinDir | Out-Null
    Copy-Item -LiteralPath $Hostd -Destination $script:Bin -Force
    $v = Invoke-Native $script:Bin @('--version') 30
    Write-Host "$($script:Bin): $($v.Out.Trim()) (exit $($v.ExitCode)) $($v.Err.Trim())"
    if ($v.ExitCode -ne 0) { Stop-Refused "$($script:Bin) does not run: $($v.Err)" }
    # What a reboot leaves in the ledger: one agent whose omp ended (architecture 3.25, AgentEnded).
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $ledger = '{"sessions":{"default":{"ci-login-item":{"record":{"agentId":"ci-login-item","name":"ci-login-item","kind":"omp","title":"Login item check (CI)","ended":{"at":' + $at + ',"cause":"reboot","reason":"the host restarted","turn":"idle"}}}}}}'
    [System.IO.File]::WriteAllText((Join-Path $script:HostdHome 'ledger.json'), $ledger, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host $ledger
    Write-EndGroup
}

# Everything schtasks says about the task now, for the log.
function Save-TaskSnapshot([string]$Name) {
    if (-not $script:TaskName) { return }
    $v = Invoke-Schtasks @('/Query', '/TN', $script:TaskName, '/V', '/FO', 'LIST')
    Save-Text "schtasks-$Name.txt" ("exit $($v.ExitCode)`n$($v.Out)`n$($v.Err)")
}
# One field of `schtasks /Query /V /FO LIST` ("Status", "Last Result"), or ''.
function Get-TaskField([string]$Field) {
    if (-not $script:TaskName) { return '' }
    $v = Invoke-Schtasks @('/Query', '/TN', $script:TaskName, '/V', '/FO', 'LIST')
    $line = @($v.Out -split "`r?`n" | Where-Object { $_ -match ('^' + [regex]::Escape($Field) + ':') } | Select-Object -First 1)
    if ($line.Count -eq 0) { return '' }
    return ($line[0] -replace ('^' + [regex]::Escape($Field) + ':\s*'), '').Trim()
}

# -- (a) and (c, the files) -------------------------------------------------------------------------
function Test-Install {
    Write-Group '(a) the daemon the app starts installs the login task by default'
    $r = Invoke-WireCall 'host.autoResume'
    if (-not (Test-CallOk $r)) {
        Add-Fail '(a) the daemon starts' "tf-hostd attach did not answer host.autoResume: $($r.Message) $($r.Err)"
        Write-EndGroup
        return $false
    }
    Add-Fact "host.autoResume right after the start: $((Get-JsonMember $script:Call 'result') | ConvertTo-Json -Compress -Depth 5)"
    if (-not (Wait-Until { Test-TaskInstalled })) {
        Save-Text 'schtasks-list-missing.txt' ((Invoke-Schtasks @('/Query', '/FO', 'LIST')).Out)
        $state = Get-BootServiceState
        Add-Fail '(a) the login task is installed' "after $WaitSeconds s there is no 'TeleFlock host service ...' task with its files ($($script:XmlFile), $($script:Launcher)): task found: $(@(Get-TeleFlockTasks) -join ', '), xml: $(Test-Path -LiteralPath $script:XmlFile), launcher: $(Test-Path -LiteralPath $script:Launcher); the daemon says: $(if ($state) { $state | ConvertTo-Json -Compress } else { 'nothing' })"
        Write-EndGroup
        return $false
    }
    Add-Pass "(a) installed $($script:Waited) s after the daemon started: schtasks /Query finds '$($script:TaskName)'"
    if ($script:TaskName -ne $script:ExpectedTask) {
        Add-Warning 'task name' "the task is '$($script:TaskName)', the home's hash says '$($script:ExpectedTask)': the hash of paths.rs and this script disagree"
    }
    Save-TaskSnapshot 'installed'
    Test-TaskDefinition '(a)'
    Test-LauncherFile
    Write-EndGroup
    return $true
}

function Test-TaskDefinition([string]$Label) {
    $xml = Get-TaskXml $script:TaskName
    if (-not $xml) {
        Add-Fail "$Label the task's XML can be read" "schtasks /Query /TN '$($script:TaskName)' /XML gave nothing usable"
        return
    }
    Save-Text ("task-$(Get-Slug $Label).xml") $xml
    $info = Get-DaemonInfo
    $port = if ($info -and $info.RelayPort) { [string]$info.RelayPort } else { '47466' }
    $problems = @(Test-TaskXml $xml $script:Sid $script:Launcher "ensure --relay-port $port")
    if ($problems.Count -eq 0) {
        Add-Pass "$Label the task is a logon trigger (this user, 1 min delay, every 10 min) running '$($script:LauncherName) ensure' as this user (InteractiveToken, LeastPrivilege)"
    } else {
        Add-Fail "$Label the task says what automations/schtasks.rs promises" ($problems -join '; ')
    }
}

# (c): the launcher is tf-hostd.exe with the subsystem byte changed, and the file is where the task says.
function Test-LauncherFile {
    if (-not (Test-Path -LiteralPath $script:Launcher)) {
        Add-Fail '(c) the launcher exists' "$($script:Launcher) is missing"
        return
    }
    $program = Get-PeInfo $script:Bin
    $launcher = Get-PeInfo $script:Launcher
    if ($program.IsPe -and $launcher.IsPe -and $program.Subsystem -eq 3 -and $launcher.Subsystem -eq 2) {
        Add-Pass "(c) $($script:ExeName) is a console program (subsystem 3) and $($script:LauncherName) a GUI program (subsystem 2: Windows gives it no console)"
    } else {
        Add-Fail '(c) the launcher is a GUI program' "$($script:ExeName): PE $($program.IsPe), subsystem $($program.Subsystem); $($script:LauncherName): PE $($launcher.IsPe), subsystem $($launcher.Subsystem)"
        return
    }
    $sizes = @((Get-Item -LiteralPath $script:Bin).Length, (Get-Item -LiteralPath $script:Launcher).Length)
    if ($sizes[0] -ne $sizes[1]) {
        Add-Fail '(c) the launcher is a copy of tf-hostd.exe' "sizes differ: $($sizes[0]) and $($sizes[1]) bytes"
        return
    }
    $want = Get-PatchedHash $script:Bin $program.Offset 2
    $have = Get-FileSha256 $script:Launcher
    if ($want -eq $have) {
        Add-Pass "(c) $($script:LauncherName) is $($script:ExeName) with the one subsystem byte (offset $($program.Offset)) changed, byte for byte"
    } else {
        Add-Fail '(c) the launcher is a copy of tf-hostd.exe' "its hash $have is not that of tf-hostd.exe with only the subsystem byte changed ($want)"
    }
}

# -- (b), (c, the run), (e) -------------------------------------------------------------------------
# A throwaway task that runs a console program: what Task Scheduler does to one. It tells whether the trace
# below can see a console host at all, and how one relates to its program, so that "no console host for
# the launcher" means something. It only informs: a runner where it does not work gets a warning, and
# the checks of the launcher then say how weak their evidence is.
function Invoke-ConsoleControl {
    Write-Group '(c) control: a console program started by Task Scheduler gets a console host'
    $script:TraceTrusted = $false
    $script:ConsoleParentIsClient = $false
    $ping = Join-Path (Join-Path $(if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }) 'System32') 'ping.exe'
    $created = Invoke-Schtasks @('/Create', '/TN', $script:ControlTask, '/TR', "$ping -n 8 127.0.0.1", '/SC', 'ONCE', '/ST', '23:59', '/F')
    if ($created.ExitCode -ne 0) {
        Add-Fact "control task could not be created ($($created.Err.Trim() -replace '\s+', ' ')): the console check has no control"
        Write-EndGroup
        return
    }
    $script:Sampled = @{}
    $traced = Start-ProcessTrace
    $script:Sampling = -not $traced
    $ran = Invoke-Schtasks @('/Run', '/TN', $script:ControlTask)
    $events = @()
    if ($ran.ExitCode -eq 0) {
        $sawPing = Wait-Until {
            if ($script:Sampling) { Add-ProcessSample; return (@($script:Sampled.Values | Where-Object { $_.Name -ieq 'ping.exe' }).Count -gt 0) }
            return (@(Read-ProcessTrace | Where-Object { $_.Name -ieq 'ping.exe' }).Count -gt 0)
        } 20 250
        if ($sawPing) {
            Start-Sleep -Seconds 3
            if ($script:Sampling) { Add-ProcessSample }
        }
        $events = if ($script:Sampling) { @($script:Sampled.Values) } else { @(Read-ProcessTrace) }
    }
    Stop-ProcessTrace
    $script:Sampling = $false
    $null = Invoke-Schtasks @('/Delete', '/TN', $script:ControlTask, '/F')
    Save-ProcessTrace 'trace-control.txt' $events
    $pings = @($events | Where-Object { $_.Name -ieq 'ping.exe' })
    if ($pings.Count -eq 0) {
        Add-Fact "control: ping.exe was not seen to start ($($ran.Out.Trim() -replace '\s+', ' ') $($ran.Err.Trim() -replace '\s+', ' ')): the console check has no control"
        Write-EndGroup
        return
    }
    $family = @(Get-Descendants $events @($pings | ForEach-Object { $_.Pid }))
    $hostsSeen = @($events | Where-Object { $script:ConsoleHosts -contains $_.Name })
    $ownHosts = @($hostsSeen | Where-Object { $family -contains $_.ParentPid })
    if ($ownHosts.Count -gt 0) {
        $script:TraceTrusted = $true
        $script:ConsoleParentIsClient = $true
        Add-Fact "control: ping.exe, a console program started by Task Scheduler, got $($ownHosts[0].Name) (pid $($ownHosts[0].Pid)) as a child: the trace sees a console host, and tells it by its parent"
    } elseif ($hostsSeen.Count -gt 0) {
        $script:TraceTrusted = $true
        Add-Fact "control: ping.exe got $($hostsSeen[0].Name) (pid $($hostsSeen[0].Pid)) but as a child of pid $($hostsSeen[0].ParentPid), not of ping.exe: a console host is not told by its parent here, so any that starts counts"
    } else {
        Add-Warning 'console control' 'ping.exe ran from Task Scheduler and no console host was seen for it: on this runner the checks of the launcher cannot tell a console from none'
    }
    Write-EndGroup
}

# Kills the daemon by pid (checked), shows it stays down, runs the trigger (a scriptblock that returns
# a schtasks result) and waits for a daemon with another pid that answers. `Trace`: also records what
# starts while the task runs and checks that no console host does ((c)).
function Invoke-Revive([string]$Name, [scriptblock]$Trigger, [bool]$Trace) {
    $found = @(Get-DaemonProcesses)
    if ($found.Count -ne 1) {
        Add-Fail $Name "expected exactly one daemon, found $($found.Count): $(($found | ForEach-Object { "$($_.Pid) $($_.CommandLine)" }) -join '; ')"
        return $false
    }
    $script:OldPid = $found[0].Pid
    $info = Get-DaemonInfo
    if (-not $info -or $info.Pid -ne $script:OldPid) {
        Add-Fail $Name "the daemon that answers (pid $(if ($info) { $info.Pid } else { 'none' })) is not the process found (pid $($script:OldPid))"
        return $false
    }
    try { Stop-DaemonProcess $script:OldPid } catch { Add-Fail $Name "cannot stop pid $($script:OldPid): $($_.Exception.Message)"; return $false }
    if (-not (Wait-Until { -not (Test-ProcessAlive $script:OldPid) } 15)) {
        Add-Fail $Name "pid $($script:OldPid) did not die after it was stopped"
        return $false
    }
    Start-Sleep -Seconds 3
    $again = @(Get-DaemonProcesses)
    if ($again.Count -gt 0) {
        Add-Fail $Name "a daemon runs again by itself before the trigger: pid $(($again | ForEach-Object { $_.Pid }) -join ', ')"
        return $false
    }
    Add-Pass "${Name}: daemon pid $($script:OldPid) stopped and verified down"
    $traced = $false
    $script:Sampled = @{}
    $script:Sampling = $false
    if ($Trace) {
        $traced = Start-ProcessTrace
        $script:Sampling = -not $traced
    }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $fired = & $Trigger
    Write-Host "trigger: exit $($fired.ExitCode) $($fired.Out.Trim()) $($fired.Err.Trim())"
    if ($fired.ExitCode -ne 0) {
        if ($traced) { Stop-ProcessTrace }
        $script:Sampling = $false
        Save-TaskSnapshot "after-$(Get-Slug $Name)"
        Add-Fail $Name "the trigger failed: $($fired.Out.Trim()) $($fired.Err.Trim())"
        return $false
    }
    $came = Wait-Until {
        if ($script:Sampling) { Add-ProcessSample }
        $d = @(Get-DaemonProcesses | Where-Object { $_.Pid -ne $script:OldPid })
        if ($d.Count -gt 0) { $script:NewPid = $d[0].Pid; return $true }
        return $false
    } $WaitSeconds 250
    $up = [int][Math]::Round($clock.Elapsed.TotalSeconds)
    # A quiet moment: this script starts nothing now, so any console host that shows up is the launcher's or
    # the daemon's. The trace is read before the status call below starts processes of its own.
    $events = @()
    $fromTrace = $traced
    if ($Trace) {
        if ($came) { Start-Sleep -Seconds 5 }
        if ($script:Sampling) { Add-ProcessSample; $events = @($script:Sampled.Values) } else { $events = @(Read-ProcessTrace) }
        if ($traced) { Stop-ProcessTrace }
        $script:Sampling = $false
        Save-ProcessTrace "trace-$(Get-Slug $Name).txt" $events
    }
    Save-TaskSnapshot "after-$(Get-Slug $Name)"
    if (-not $came) {
        Add-Fail $Name "no daemon within $WaitSeconds s of the trigger (it said: $($fired.Out.Trim() -replace '\s+', ' '); the task's Status is '$(Get-TaskField 'Status')', its Last Result '$(Get-TaskField 'Last Result')'); see schtasks-after-$(Get-Slug $Name).txt, task-scheduler-events.txt, home-hostd.log.txt"
        return $false
    }
    $info = Get-DaemonInfo
    if (-not $info -or $info.Pid -ne $script:NewPid) {
        Add-Fail $Name "a daemon started (pid $($script:NewPid)) but a status call was not answered by it (pid $(if ($info) { $info.Pid } else { 'none' }))"
        return $false
    }
    if ($up -le 60) {
        Add-Pass "${Name}: daemon back as pid $($script:NewPid) $up s after the trigger, and it answers a status call"
    } else {
        Add-Fail $Name "the daemon came back after $up s (the limit is 60 s)"
    }
    $daemon = @(Get-DaemonProcesses | Where-Object { $_.Pid -eq $script:NewPid } | Select-Object -First 1)
    if ($daemon.Count -eq 1) {
        Add-Fact "${Name}: daemon pid $($script:NewPid), parent pid $($daemon[0].ParentPid), $($daemon[0].Path)"
        Test-RunFromRealProgram $Name $daemon[0]
    }
    Add-Fact "${Name}: task Status '$(Get-TaskField 'Status')', Last Result '$(Get-TaskField 'Last Result')' (Running and 267009 mean the daemon stayed in the task's job; Ready and 0, it broke away)"
    if ($Trace) { Test-RunTrace $Name $events $script:NewPid $fromTrace }
    return $true
}

# (c) The daemon runs from the real tf-hostd.exe, not from the launcher's copy, and has no console.
function Test-RunFromRealProgram([string]$Name, $Daemon) {
    if (Test-SamePath $Daemon.Path $script:Bin) {
        Add-Pass "(c) the daemon the task started runs from $($script:Bin), not from $($script:LauncherName)"
    } else {
        Add-Fail '(c) the daemon runs from the real tf-hostd.exe' "it runs from '$($Daemon.Path)' (command line: $($Daemon.CommandLine)), expected '$($script:Bin)'"
    }
    $children = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($Daemon.Pid)" -ErrorAction SilentlyContinue)
    $hostsNow = @($children | Where-Object { $script:ConsoleHosts -contains $_.Name })
    if ($hostsNow.Count -eq 0) {
        Add-Pass "(c) no console host is a child of the running daemon (its children now: $(if ($children.Count) { ($children | ForEach-Object { $_.Name }) -join ', ' } else { 'none' }))"
    } else {
        Add-Fail '(c) the daemon has no console' "$($hostsNow[0].Name) (pid $($hostsNow[0].ProcessId)) is a child of the daemon"
    }
}

# (c) What starting the task did, from the trace (`FromTrace`) or from polling the process table.
function Test-RunTrace([string]$Name, $Events, [int]$DaemonPid, [bool]$FromTrace) {
    $problems = @(Test-LaunchTrace $Events $DaemonPid (-not $script:ConsoleParentIsClient) (-not $FromTrace))
    if ($problems.Count -gt 0) {
        Add-Fail '(c) no console window for the launcher or the daemon' ($problems -join '; ')
        return
    }
    $seen = @($Events | Where-Object { $_.Name -ieq $script:LauncherName }).Count
    if ($FromTrace -and $script:TraceTrusted -and $seen -gt 0) {
        Add-Pass "(c) while the task ran, $($script:LauncherName) started the daemon (pid $DaemonPid) and no console host was started for either or for anything they started ($(@($Events).Count) process starts in the trace; the control showed it sees a console host for a console program)"
    } elseif ($FromTrace -and $seen -gt 0) {
        Add-Pass "(c) while the task ran, $($script:LauncherName) started the daemon (pid $DaemonPid) and no console host was started for either (weak: the control did not show that this trace sees a console host here)"
        Add-Warning 'console check' 'no console host was seen for the launcher, but the control did not show that the trace sees one on this runner'
    } else {
        Add-Pass "(c) while the task ran, no console host was started for the daemon (pid $DaemonPid) or its children; the polled process table $(if ($seen -gt 0) { 'saw' } else { 'did not see' }) the launcher (weak: it may start and end between two looks)"
        Add-Warning 'console check' 'no trace of process starts could be had: the launcher was only looked for by polling'
    }
}

function Invoke-ReviveByRun([string]$Name, [bool]$Trace) {
    return (Invoke-Revive $Name { Invoke-Schtasks @('/Run', '/TN', $script:TaskName) } $Trace)
}

function Test-Revive {
    Write-Group '(b) the daemon is gone; the login task brings it back (schtasks /Run)'
    Invoke-ConsoleControl
    $null = Invoke-ReviveByRun '(b) schtasks /Run' $true
    Write-EndGroup
    Write-Group '(b) the task runs while the daemon lives (what it does every 10 minutes): nothing changes'
    Test-PeriodicRun
    Write-EndGroup
}

# The repeated run of the task is `ensure` against a daemon that is up: it must start no second one.
function Test-PeriodicRun {
    $before = @(Get-DaemonProcesses)
    if ($before.Count -ne 1) {
        Add-Fail '(b) a run of the task while the daemon lives' "expected exactly one daemon, found $($before.Count)"
        return
    }
    $fired = Invoke-Schtasks @('/Run', '/TN', $script:TaskName)
    Write-Host "trigger: exit $($fired.ExitCode) $($fired.Out.Trim()) $($fired.Err.Trim())"
    Start-Sleep -Seconds 8
    $after = @(Get-DaemonProcesses)
    if ($fired.ExitCode -ne 0) {
        Add-Fail '(b) a run of the task while the daemon lives' "schtasks /Run failed: $($fired.Out.Trim()) $($fired.Err.Trim())"
    } elseif ($after.Count -eq 1 -and $after[0].Pid -eq $before[0].Pid) {
        Add-Pass "(b) a run of the task while the daemon lives (schtasks /Run, as every 10 minutes) starts no second daemon: pid $($before[0].Pid) stays the only one"
    } else {
        Add-Fail '(b) a run of the task while the daemon lives' "daemon pids were $($before[0].Pid), are $(($after | ForEach-Object { $_.Pid }) -join ', ')"
    }
}

# -- (d), (e) the setting ---------------------------------------------------------------------------
function Test-OffOn {
    Write-Group '(d) Settings -> Auto-resume -> Bring agents back after a reboot: off'
    if (@(Get-DaemonProcesses).Count -eq 0) {
        Add-Fact 'no daemon runs at this point (a check before failed): one is started, so the setting can be called'
        $null = Invoke-WireCall 'host.autoResume'
        Start-Sleep -Seconds 3
    }
    $before = @(Get-DaemonProcesses | Select-Object -First 1)
    $r = Invoke-WireCall 'host.autoResumeSet' '{"bringBack":false}'
    if (-not (Test-CallOk $r)) {
        Add-Fail '(d) the setting can be switched off' "host.autoResumeSet answered: $($r.Message) $($r.Err)"
        Write-EndGroup
        return
    }
    if (Wait-Until { (Test-TaskGone) -and (Test-FilesGone) }) {
        Add-Pass "(d) off: the task is deleted (schtasks /Query fails) and $($script:XmlFile) and $($script:Launcher) are gone, $($script:Waited) s"
    } else {
        Save-TaskSnapshot 'off'
        Add-Fail '(d) off removes the login task and its files' "after $WaitSeconds s: task there: $(-not (Test-TaskGone)), $($script:XmlFile): $(Test-Path -LiteralPath $script:XmlFile), $($script:Launcher): $(Test-Path -LiteralPath $script:Launcher); see schtasks-off.txt, home-hostd.log.txt"
    }
    if (Wait-Until { Test-BootServiceGone } 30) {
        Add-Pass '(d) host.autoResume reports it not installed'
    } else {
        Add-Fail '(d) host.autoResume reports it not installed' "$((Get-BootServiceState) | ConvertTo-Json -Compress)"
    }
    # The daemon deleted the task it was started by (when it was): does Task Scheduler take it along?
    Start-Sleep -Seconds 3
    if ($before.Count -eq 0) {
        Add-Fact 'no daemon was running to watch while its login task was switched off'
    } elseif (Test-ProcessAlive $before[0].Pid) {
        Add-Fact "the daemon (pid $($before[0].Pid)) survived switching its login task off"
    } else {
        Add-Warning 'daemon died with its task' "the daemon (pid $($before[0].Pid)) did not survive switching its own login task off: Task Scheduler may end a task's processes when the task is deleted"
    }
    Write-EndGroup

    Write-Group '(e) on again'
    $r = Invoke-WireCall 'host.autoResumeSet' '{"bringBack":true}'
    if (-not (Test-CallOk $r)) {
        Add-Fail '(e) the setting can be switched on' "host.autoResumeSet answered: $($r.Message) $($r.Err)"
        Write-EndGroup
        return
    }
    if (Wait-Until { Test-TaskInstalled }) {
        Add-Pass "(e) on: task '$($script:TaskName)', $($script:XmlFile) and $($script:Launcher) are back, $($script:Waited) s"
        Save-TaskSnapshot 'reinstalled'
        Test-TaskDefinition '(e)'
        Test-LauncherFile
    } else {
        Save-TaskSnapshot 'on'
        Add-Fail '(e) on installs the login task again' "after $WaitSeconds s: task there: $(@(Get-TeleFlockTasks) -join ', '), xml: $(Test-Path -LiteralPath $script:XmlFile), launcher: $(Test-Path -LiteralPath $script:Launcher); see schtasks-on.txt, home-hostd.log.txt"
        Write-EndGroup
        return
    }
    if (Wait-Until { Test-BootServiceInstalled }) { Add-Pass '(e) host.autoResume reports it installed again' } else { Add-Fail '(e) host.autoResume reports it installed again' "$((Get-BootServiceState) | ConvertTo-Json -Compress)" }
    Write-EndGroup
    Write-Group '(e) the recreated login task starts the daemon too'
    $null = Invoke-ReviveByRun '(e) recreated task, schtasks /Run' $false
    Write-EndGroup
}

# -- (f) leave the runner as it was, keep the logs ----------------------------------------------------
function Remove-Everything {
    if (@(Get-DaemonProcesses).Count -gt 0) {
        $null = Invoke-WireCall 'host.autoResumeSet' '{"bringBack":false}'
        $null = Wait-Until { (Test-TaskGone) -and (Test-FilesGone) } 20
    }
    foreach ($name in @(Get-TeleFlockTasks) + @($script:ControlTask)) { $null = Invoke-Schtasks @('/Delete', '/TN', $name, '/F') }
    $stop = Invoke-Native $script:Bin @('stop') 40
    Save-Text 'stop.txt' "exit $($stop.ExitCode)`n$($stop.Out)`n$($stop.Err)"
    foreach ($d in @(Get-DaemonProcesses)) { Stop-Process -Id $d.Pid -Force -ErrorAction SilentlyContinue }
    Stop-ProcessTrace
}

function Save-Logs {
    foreach ($f in @('hostd.log', 'ledger.json', 'autoresume.json', 'state.json', 'tools.json', 'automations.json', 'login-task.xml')) {
        $p = Join-Path $script:HostdHome $f
        if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $LogDir "home-$f.txt") -Force -ErrorAction SilentlyContinue }
    }
    Save-Text 'files.txt' ((Get-ChildItem -LiteralPath $script:HostdHome -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { '{0,12} {1}' -f $_.Length, $_.FullName }) -join "`n")
    Save-Text 'processes.txt' ((Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'tf-hostd*' } | Format-List ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | Out-String))
    $events = Invoke-Native 'wevtutil.exe' @('qe', 'Microsoft-Windows-TaskScheduler/Operational', '/c:400', '/rd:true', '/f:text') 90
    Save-Text 'task-scheduler-events.txt' "exit $($events.ExitCode)`n$($events.Out)`n$($events.Err)"
}

function Save-Summary {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('### Windows login task (Task Scheduler)')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("$([System.Environment]::OSVersion.VersionString), $(& { try { (Invoke-Native $script:Bin @('--version') 20).Out.Trim() } catch { '' } })")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| | check |')
    [void]$sb.AppendLine('|---|---|')
    foreach ($r in $script:Results) {
        # One line, and no pipe: either would end the table cell.
        $cell = ($r.Text -replace '[\r\n]+', ' ') -replace '\|', '\|'
        [void]$sb.AppendLine($(if ($r.Ok) { "| pass | $cell |" } else { "| **FAIL** | $cell |" }))
    }
    if ($script:Facts.Count -gt 0) {
        [void]$sb.AppendLine()
        [void]$sb.AppendLine('<details><summary>observations</summary>')
        [void]$sb.AppendLine()
        foreach ($f in $script:Facts) { [void]$sb.AppendLine("- $f") }
        [void]$sb.AppendLine()
        [void]$sb.AppendLine('</details>')
    }
    Save-Text 'summary.md' $sb.ToString()
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $sb.ToString() -Encoding UTF8 }
}

# Cleans up, saves the logs and the summary, and sets $script:ExitCode (the script exits with it, last).
function Complete-Run([int]$Status) {
    if ($script:Finished) { return }
    $script:Finished = $true
    Write-Group '(f) leave the runner clean, keep the logs'
    try { Remove-Everything } catch { Write-Host "clean-up: $($_.Exception.Message)" }
    try { Save-Logs } catch { Write-Host "logs: $($_.Exception.Message)" }
    try { Save-Summary } catch { Write-Host "summary: $($_.Exception.Message)" }
    Write-EndGroup
    if ($script:Failures -gt 0) {
        Write-Host ''
        Write-Host "$($script:Failures) check(s) failed:"
        foreach ($r in $script:Results) { if (-not $r.Ok) { Write-Host "  - $($r.Text)" } }
        $script:ExitCode = 1
    } elseif ($script:Refused) {
        Write-Host ''
        Write-Host 'refused to run (see above)'
        $script:ExitCode = 64
    } elseif ($Status -ne 0) {
        Write-Host ''
        Write-Host "the script stopped with status $Status before every check ran"
        $script:ExitCode = $Status
    } else {
        Write-Host ''
        Write-Host "all $($script:Results.Count) checks passed"
        $script:ExitCode = 0
    }
}

function Invoke-Main {
    Initialize-State
    Assert-Preflight
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    try { Start-Transcript -Path (Join-Path $LogDir 'run.log') -Force | Out-Null } catch { Write-Host "no transcript: $($_.Exception.Message)" }
    $status = 0
    try {
        Write-Machine
        Install-Binary
        if (Test-Install) {
            Test-Revive
            Test-OffOn
        } else {
            Add-Fact 'the login task never appeared, so the checks that need it were skipped'
        }
    } catch {
        Add-Fail 'the script itself' "$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
        $status = 1
    } finally {
        Complete-Run $status
        try { Stop-Transcript | Out-Null } catch { Write-Verbose 'no transcript' }
    }
}

# Dot-sourcing (a test of the functions above) loads them without running anything.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main
    exit $script:ExitCode
}
