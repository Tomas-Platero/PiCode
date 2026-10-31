/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How the swap script is started. No `detached`: on Windows that is `DETACHED_PROCESS`, which
 * leaves `cmd.exe` with no console at all and makes Windows ignore `windowsHide`
 * (`CREATE_NO_WINDOW` is dropped next to `DETACHED_PROCESS`). Every console tool the script then
 * runs (`tasklist`, `find`, `ping`) gets a brand-new visible console — with Windows Terminal as
 * the default terminal, an empty tab titled `find.exe` for the whole update. With `windowsHide`
 * alone the script gets one hidden console its tools share, and `unref()` lets it outlive the
 * editor: a Windows child is not killed when its parent quits.
 */
export function archiveSwapSpawnOptions(): { windowsHide: true; stdio: ['ignore', 'ignore', 'ignore'] } {
	return { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] };
}

/**
 * The batch script that swaps a staged portable build into place once the
 * running one has quit. Everything is baked in: the folder being replaced, the
 * staged copy beside it, the executable's name and the process to wait for.
 *
 * The portable profile (`data/`) moves across, so nothing the owner keeps is
 * still in the old folder when it is deleted. The script leaves itself in the
 * new folder — the next update's staging removes it with the rest.
 */
export function archiveSwapScript(appDir: string, stagingDir: string, exeName: string, pid: number, healthTries = 60): string {
	return [
		'@echo off',
		'rem PiCode portable self-update: waits for the editor to quit, moves the',
		'rem staged build into place (the portable profile moves across) and starts it.',
		'setlocal enabledelayedexpansion',
		`set "OLD=${appDir}"`,
		`set "NEW=${stagingDir}"`,
		`set "PID=${pid}"`,
		`set "EXE=${exeName}"`,
		':wait',
		// Windows' own tools by full path: a machine with Git's `usr\bin` first in PATH would
		// run GNU `find` here, which is a different program and fails.
		'"%SystemRoot%\\System32\\tasklist.exe" /FI "PID eq %PID%" 2>nul | "%SystemRoot%\\System32\\find.exe" "%PID%" >nul',
		'if not errorlevel 1 (',
		'  ping -n 2 127.0.0.1 >nul',
		'  goto wait',
		')',
		'set /a TRIES=0',
		':swap',
		'move /y "%OLD%" "%OLD%.old" >nul 2>&1',
		'if errorlevel 1 (',
		'  set /a TRIES+=1',
		'  if !TRIES! lss 30 (',
		'    ping -n 2 127.0.0.1 >nul',
		'    goto swap',
		'  )',
		'  goto fail',
		')',
		'move /y "%NEW%" "%OLD%" >nul 2>&1',
		'if errorlevel 1 (',
		'  move /y "%OLD%.old" "%OLD%" >nul 2>&1',
		'  goto fail',
		')',
		// The profile is the one thing that must arrive: a child process outliving
		// the editor (a crashpad, a GPU helper killed with it) holds a file inside
		// data/ for a while, so this move retries as patiently as the swap does.
		'set /a DTRIES=0',
		':data',
		'if exist "%OLD%.old\\data" (',
		'  move /y "%OLD%.old\\data" "%OLD%\\data" >nul 2>&1',
		'  if errorlevel 1 (',
		'    set /a DTRIES+=1',
		'    if !DTRIES! lss 30 (',
		'      ping -n 2 127.0.0.1 >nul',
		'      goto data',
		'    )',
		'  )',
		')',
		// The new build has to prove it started: it deletes `update-verify` and writes
		// `data\.update-ok` once its window has been up for a few seconds. Until then the old
		// build stays beside it, and if the proof never comes the old one is put back.
		'del "%OLD%\\data\\.update-ok" >nul 2>&1',
		'echo pending> "%OLD%\\update-verify"',
		'start "" "%OLD%\\%EXE%"',
		'set /a HTRIES=0',
		':health',
		'if exist "%OLD%\\data\\.update-ok" goto healthy',
		'set /a HTRIES+=1',
		`if !HTRIES! geq ${healthTries} goto rollback`,
		'ping -n 4 127.0.0.1 >nul',
		'goto health',
		':healthy',
		'del "%OLD%\\data\\.update-ok" >nul 2>&1',
		'rd /s /q "%OLD%.old" >nul 2>&1',
		'exit /b 0',
		':rollback',
		'rem The new build never came up: stop it, then bring back the profile and the old build.',
		'"%SystemRoot%\\System32\\taskkill.exe" /f /im "%EXE%" >nul 2>&1',
		'ping -n 4 127.0.0.1 >nul',
		'move /y "%OLD%\\data" "%OLD%.old\\data" >nul 2>&1',
		'move /y "%OLD%" "%OLD%.bad" >nul 2>&1',
		'move /y "%OLD%.old" "%OLD%" >nul 2>&1',
		'start "" "%OLD%\\%EXE%"',
		'rd /s /q "%OLD%.bad" >nul 2>&1',
		'exit /b 1',
		':fail',
		'rem Everything stays as it was: the old build is back where it was.',
		'if not exist "%OLD%\\%EXE%" move /y "%OLD%.old" "%OLD%" >nul 2>&1',
		'exit /b 1',
		'',
	].join('\r\n');
}
