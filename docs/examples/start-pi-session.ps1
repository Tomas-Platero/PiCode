<#
.SYNOPSIS
	Starts a pi chat in PiCode for one task and prints the pi session id.

.DESCRIPTION
	Reference client for PiCode's local agent bridge (docs/ENTRADA-LOCAL.md). It must run as the
	same Windows user as PiCode, on the same computer: the bridge refuses everyone else.

	1. Reads <UserData>\agent-bridge.json (pipe name, token, PiCode executable).
	2. If PiCode is not listening, starts it as this user with the project folder and waits for the
	   bridge to come up (up to 60 seconds), re-reading the token each time.
	3. Sends one session.start request and prints the reply.
	4. If no reply arrives (PiCode closed meanwhile, or it took too long), connects again, starting
	   PiCode if needed, and sends the same request with the same task id. That is safe: PiCode never
	   sends one task's assignment twice.

	Enable the bridge first: Settings > Chat and agent > Let other apps start chats.

.EXAMPLE
	.\start-pi-session.ps1 -UserData "$env:APPDATA\PiCode" -Folder D:\projects\shop -TaskId OMPM-42 -Prompt "Fix the login"
#>
param(
	[Parameter(Mandatory = $true)][string]$UserData,
	[Parameter(Mandatory = $true)][string]$Folder,
	[Parameter(Mandatory = $true)][string]$TaskId,
	[Parameter(Mandatory = $true)][string]$Prompt,
	[switch]$ResendUncertain,
	[int]$ReplyTimeoutSeconds = 240,
	[int]$Attempts = 2
)

$ErrorActionPreference = 'Stop'
$infoFile = Join-Path $UserData 'agent-bridge.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Info {
	if (-not (Test-Path -LiteralPath $infoFile)) { return $null }
	try { return Get-Content -LiteralPath $infoFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Open-Pipe($info) {
	if ($null -eq $info -or -not $info.pipe -or -not $info.token) { return $null }
	$name = $info.pipe -replace '^\\\\\.\\pipe\\', ''
	$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
	try { $client.Connect(2000); return $client } catch { $client.Dispose(); return $null }
}

# Connect, starting PiCode when it is closed.
function Connect-PiCode {
	$info = Read-Info
	$pipe = Open-Pipe $info
	if ($null -ne $pipe) { return @($info, $pipe) }
	if ($null -eq $info -or -not $info.exe) {
		throw "PiCode's bridge is off or PiCode has never run with it on. Turn on 'Let other apps start chats' in Settings."
	}
	Write-Host 'PiCode is not running; starting it...'
	Start-Process -FilePath $info.exe -ArgumentList @("`"$Folder`"")
	$deadline = (Get-Date).AddSeconds(60)
	while ((Get-Date) -lt $deadline) {
		Start-Sleep -Milliseconds 500
		$info = Read-Info
		$pipe = Open-Pipe $info
		if ($null -ne $pipe) { return @($info, $pipe) }
	}
	throw 'PiCode did not open its bridge in time.'
}

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
	$info, $pipe = Connect-PiCode
	# Built per attempt: the token changes when PiCode starts again.
	$request = @{
		token  = $info.token
		id     = [guid]::NewGuid().ToString()
		method = 'session.start'
		params = @{ folder = $Folder; taskId = $TaskId; prompt = $Prompt; resendUncertain = [bool]$ResendUncertain }
	} | ConvertTo-Json -Compress -Depth 4
	$writer = New-Object System.IO.StreamWriter($pipe, $utf8, 4096, $true)
	$writer.Write($request + "`n"); $writer.Flush(); $writer.Dispose()
	$reader = New-Object System.IO.StreamReader($pipe, $utf8, $false, 4096, $true)
	$read = $reader.ReadLineAsync()
	$answered = $false
	try { $answered = $read.Wait([TimeSpan]::FromSeconds($ReplyTimeoutSeconds)) } catch { $answered = $false }
	if ($answered -and $null -ne $read.Result) {
		$reply = $read.Result | ConvertFrom-Json
		$pipe.Dispose()
		# One JSON object on stdout either way, so a calling app can read it directly.
		if ($reply.error) {
			@{ error = @{ code = $reply.error.code; message = $reply.error.message } } | ConvertTo-Json -Compress
			exit 1
		}
		@{ sessionId = $reply.result.sessionId; taskId = $reply.result.taskId; reused = $reply.result.reused } | ConvertTo-Json -Compress
		exit 0
	}
	Write-Warning "No reply (attempt $attempt). Asking again with the same task id."
	$pipe.Dispose()
}
throw 'PiCode did not answer.'
