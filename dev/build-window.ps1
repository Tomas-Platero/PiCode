<#
.SYNOPSIS
    PiCode's build, in a small window: what is missing, a way to get it, and how much is left.

.DESCRIPTION
    The build needs things — a Node of the pinned version, Git (its Bash is what runs the build),
    jq, Python — and when one is missing the failure arrives minutes later inside a log nobody can
    read. A collaborator also has no way to know whether a build is already running, or how far it
    got: its long phases print nothing for minutes, so a terminal cannot tell "working" from
    "stuck".

    This is all of that in one window, and elsewhere nowhere: the requirements with a button that
    installs each one, one button to build, a bar with the stage and the percentage while it runs,
    the tail of its own output, and a way to stop it when it hangs (which has happened).

    It is PowerShell and WPF on purpose: it is on every Windows machine, it needs nothing installed
    to run, and a repository should not carry a GUI toolchain.

    Run it with dev/build-window.cmd, or: powershell -ExecutionPolicy Bypass -File dev/build-window.ps1
#>

[CmdletBinding()]
param(
    # Print the checks and the current state, then exit: for a terminal, a script or a test.
    [switch]$Check,
    # Build the window and check its controls, without showing it: what a machine can verify about
    # a GUI. It catches a window that cannot be built at all.
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackDir = Join-Path $RepoRoot 'VSCode-win32-x64'
$Scratch = Join-Path $RepoRoot '.scratch'
$LockFile = Join-Path $Scratch 'build.lock'
$StatusFile = Join-Path $Scratch 'build.status'
$LogFile = Join-Path $Scratch 'build-live.log'
$NodeModules = Join-Path $RepoRoot 'vscode\node_modules'

# ---------------------------------------------------------------------------
# What the build needs, and how to get it
# ---------------------------------------------------------------------------

function Get-CommandVersion([string]$name, [string]$versionArg) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    try {
        return (& $name $versionArg 2>&1 | Select-Object -First 1).ToString().Trim()
    } catch {
        return 'installed'
    }
}

<#
    One row per requirement: what it is, whether it is there, what to install it with, and where to
    read about it when there is no package manager to do it.

    The pinned Node lives in `.nvmrc`, and a mismatched one fails in phase 6 in a way nobody can
    read (native modules built against a different ABI), so it is compared rather than mentioned.
#>
function Get-Requirements {
    $rows = New-Object System.Collections.Generic.List[object]
    $winget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

    $node = Get-CommandVersion 'node' '--version'
    $wanted = if (Test-Path (Join-Path $RepoRoot '.nvmrc')) { (Get-Content (Join-Path $RepoRoot '.nvmrc') -Raw).Trim() } else { '' }
    $nodeOk = $false
    if ($node) {
        $haveMajor = [int]($node.TrimStart('v').Split('.')[0])
        $wantMajor = if ($wanted) { [int]($wanted.Split('.')[0]) } else { $haveMajor }
        $nodeOk = $haveMajor -ge $wantMajor
    }
    $rows.Add([pscustomobject]@{
        Name = 'node'
        Ok = $nodeOk
        Detail = if (-not $node) { 'not found on PATH' } elseif (-not $nodeOk) { "$node, but .nvmrc asks for $wanted" } else { $node }
        Install = 'OpenJS.NodeJS.LTS'
        Url = 'https://nodejs.org/en/download'
        Note = 'the version in .nvmrc is the one the build pins'
    })

    $rows.Add([pscustomobject]@{
        Name = 'git'
        Ok = [bool](Get-Command git -ErrorAction SilentlyContinue)
        Detail = Get-CommandVersion 'git' '--version'
        Install = 'Git.Git'
        Url = 'https://git-scm.com/download/win'
        Note = 'Git Bash is what runs the build'
    })
    $rows.Add([pscustomobject]@{
        Name = 'bash'
        Ok = [bool](Get-Command bash -ErrorAction SilentlyContinue)
        Detail = 'Git Bash'
        Install = 'Git.Git'
        Url = 'https://git-scm.com/download/win'
        Note = 'comes with Git for Windows'
    })
    $rows.Add([pscustomobject]@{
        Name = 'jq'
        Ok = [bool](Get-Command jq -ErrorAction SilentlyContinue)
        Detail = Get-CommandVersion 'jq' '--version'
        Install = 'jqlang.jq'
        Url = 'https://jqlang.github.io/jq/download/'
        Note = 'the branding and the removal actions read the product with it'
    })
    $rows.Add([pscustomobject]@{
        Name = 'python3'
        Ok = [bool](Get-Command python3 -ErrorAction SilentlyContinue)
        Detail = Get-CommandVersion 'python3' '--version'
        Install = 'Python.Python.3.12'
        Url = 'https://www.python.org/downloads/windows/'
        Note = 'node-gyp builds the native modules with it'
    })
    $rows.Add([pscustomobject]@{
        Name = 'winget'
        Ok = $winget
        Detail = if ($winget) { 'available: the buttons below install with it' } else { 'not available: use the page links' }
        Install = ''
        Url = 'https://aka.ms/getwinget'
        Note = 'App Installer, from the Microsoft Store'
    })

    # The tree, its dependencies and the editor: these are the build's own work, and each one has a
    # button of its own so a failure in the middle does not force a whole build again.
    $tree = Test-Path (Join-Path $RepoRoot 'vscode\product.json')
    $rows.Add([pscustomobject]@{
        Name = 'source tree'
        Ok = $tree
        Detail = if ($tree) { 'prepared' } else { 'not fetched yet' }
        Action = 'prepare'
        Note = 'fetch and patch the pinned VS Code source'
    })
    $deps = Test-Path (Join-Path $NodeModules '@typescript\native\lib\tsc.js')
    $rows.Add([pscustomobject]@{
        Name = 'dependencies'
        Ok = $deps
        Detail = if ($deps) { 'installed' } else { 'not installed (or half done)' }
        Action = 'dependencies'
        Note = 'npm ci in vscode/, which is what the build does in its longest phase'
    })
    $editor = Test-Path (Join-Path $PackDir 'PiCode.exe')
    $rows.Add([pscustomobject]@{
        Name = 'editor built'
        Ok = $editor
        Detail = if ($editor) { 'VSCode-win32-x64\PiCode.exe' } else { 'not built yet' }
        Action = 'build'
        Note = 'compile the core and pack the editor'
    })

    $driveLetter = [System.IO.Path]::GetPathRoot($RepoRoot).TrimEnd(':', '\')
    $free = [math]::Round((Get-PSDrive -Name $driveLetter).Free / 1GB, 1)
    $rows.Add([pscustomobject]@{
        Name = 'disk free'
        Ok = $free -ge 8
        Detail = "$free GB on $driveLetter" + ':\'
        Url = ''
        Note = 'the payload is about 1 GB and the pack needs room beside it'
    })

    return $rows
}

# ---------------------------------------------------------------------------
# Is a build running, and how is it going
# ---------------------------------------------------------------------------

function Get-BuildState {
    $running = $false
    $buildPid = $null
    if (Test-Path $LockFile) {
        $raw = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue)
        if ($raw) {
            # Not `$pid`: that is PowerShell's own process id and it is read-only.
            $buildPid = $raw.Trim()
            $running = [bool](Get-Process -Id $buildPid -ErrorAction SilentlyContinue)
        }
    }
    $progress = $null
    if (Test-Path $LogFile) {
        try {
            $json = & node (Join-Path $PSScriptRoot 'build-progress.mjs') '--json' $LogFile 2>$null
            if ($json) { $progress = $json | ConvertFrom-Json }
        } catch {
            $progress = $null
        }
    }
    return [pscustomobject]@{ Running = $running; Pid = $buildPid; Progress = $progress }
}

if ($Check) {
    Get-Requirements | ForEach-Object {
        $mark = if ($_.Ok) { 'OK  ' } else { 'NO  ' }
        $how = if (-not $_.Ok) { if ($_.Action) { " — run: $($_.Action)" } elseif ($_.Install) { " — winget install $($_.Install)" } else { '' } } else { '' }
        Write-Output ("{0}{1,-14} {2}{3}" -f $mark, $_.Name, $_.Detail, $how)
    }
    $state = Get-BuildState
    $line = if ($state.Running) { "a build is running (pid $($state.Pid))" } else { 'no build is running' }
    if ($state.Progress) { $line += " - $([math]::Round($state.Progress.percentage))% - $($state.Progress.stage)" }
    Write-Output $line
    if (Test-Path $StatusFile) { Write-Output "last build exit code: $((Get-Content $StatusFile -Raw).Trim())" }
    exit 0
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="PiCode - build" Height="680" Width="820" WindowStartupLocation="CenterScreen"
        Background="#1e1e1e" Foreground="#e6e6e6" FontFamily="Segoe UI" FontSize="13">
  <Grid Margin="14">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <DockPanel Grid.Row="0" Margin="0,0,0,6">
      <Button DockPanel.Dock="Right" Name="Refresh" Content="Check again" Width="110" Height="26"/>
      <TextBlock Text="PiCode - build" FontSize="18" FontWeight="SemiBold" VerticalAlignment="Center"/>
    </DockPanel>

    <StackPanel Grid.Row="1" Name="Requirements" Margin="0,0,0,8"/>

    <DockPanel Grid.Row="2" Margin="0,0,0,8">
      <TextBlock DockPanel.Dock="Left" Text="Steps:" VerticalAlignment="Center" Margin="0,0,8,0" Opacity="0.7"/>
      <StackPanel Orientation="Horizontal">
        <Button Name="Prepare" Content="1. Source tree" Width="130" Height="28" Margin="0,0,6,0"
                ToolTip="Fetches and patches the pinned VS Code source (phases 1-5)"/>
        <Button Name="InstallDeps" Content="2. Dependencies" Width="140" Height="28" Margin="0,0,6,0"
                ToolTip="npm ci in vscode/ - the build's longest phase, on its own"/>
        <Button Name="Build" Content="3. Build" Width="90" Height="28" FontWeight="SemiBold"
                ToolTip="Compiles the core, the connector, and packs the editor"/>
        <Button Name="Stop" Content="Stop" Width="70" Height="28" Margin="6,0,0,0"
                ToolTip="Only when it hangs: the tree may need a rebuild afterwards"/>
      </StackPanel>
    </DockPanel>

    <TextBox Grid.Row="3" Name="Log" IsReadOnly="True" FontFamily="Consolas" FontSize="12"
             Background="#141414" Foreground="#cfcfcf" BorderBrush="#333" VerticalScrollBarVisibility="Auto"
             HorizontalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>

    <Grid Grid.Row="4" Margin="0,10,0,0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <ProgressBar Grid.Column="0" Name="Bar" Height="22" Minimum="0" Maximum="100" Foreground="#3d8bfd" Background="#2a2a2a"/>
      <TextBlock Grid.Column="1" Name="Percent" Text="-" Width="60" TextAlignment="Right" VerticalAlignment="Center" FontWeight="SemiBold"/>
    </Grid>

    <DockPanel Grid.Row="5" Margin="0,8,0,0">
      <Button DockPanel.Dock="Right" Name="Open" Content="Open editor" Width="110" Height="28" Margin="6,0,0,0"/>
      <TextBlock Name="Stage" Text="ready" VerticalAlignment="Center"/>
    </DockPanel>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

$requirementsPanel = $window.FindName('Requirements')
$bar = $window.FindName('Bar')
$percentText = $window.FindName('Percent')
$stageText = $window.FindName('Stage')
$buildButton = $window.FindName('Build')
$stopButton = $window.FindName('Stop')
$prepareButton = $window.FindName('Prepare')
$depsButton = $window.FindName('InstallDeps')
$refreshButton = $window.FindName('Refresh')
$openButton = $window.FindName('Open')
$logBox = $window.FindName('Log')
$logBox.Text = ''

# ---------------------------------------------------------------------------
# Running things in a visible terminal
# ---------------------------------------------------------------------------

<#
    Every install and every build step runs in its **own visible terminal**.

    Hidden would be quieter and wrong: winget asks for permission, prints what it is downloading and
    sometimes needs a second run, and npm explains the one line that matters when it fails. A window
    that swallows that leaves the owner with a button that did nothing.
#>
function Start-InTerminal([string]$title, [string]$command, [string]$workingDirectory) {
    $full = "title $title && cd /d `"$workingDirectory`" && $command"
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $full) | Out-Null
}

<# Installs one requirement with winget, in a terminal, and says so in the log. #>
function Install-Requirement($row) {
    if (-not $row.Install) {
        if ($row.Url) { Start-Process $row.Url | Out-Null }
        return
    }
    Add-Log "installing $($row.Name) with winget ($($row.Install))..."
    Start-InTerminal "PiCode - installing $($row.Name)" "winget install --id $($row.Install) -e --accept-source-agreements --accept-package-agreements" $RepoRoot
}

function Add-Log([string]$line) {
    $logBox.Text = "$($logBox.Text)`r`n[window] $line"
    $logBox.ScrollToEnd()
}

# ---------------------------------------------------------------------------
# The window
# ---------------------------------------------------------------------------

function Show-Requirements {
    $requirementsPanel.Children.Clear()
    foreach ($row in Get-Requirements) {
        $grid = New-Object System.Windows.Controls.Grid
        $grid.Margin = '0,1,0,1'
        # Mark, name, detail, and up to two buttons. The widths are given with their kind, because
        # "Auto" is not a number and casting it to one is what a plain list of strings asks for.
        foreach ($definition in @(
            @{ Width = '20'; Kind = 'Pixel' },
            @{ Width = '150'; Kind = 'Pixel' },
            @{ Width = '1'; Kind = 'Star' },
            @{ Width = '1'; Kind = 'Auto' },
            @{ Width = '1'; Kind = 'Auto' }
        )) {
            $column = New-Object System.Windows.Controls.ColumnDefinition
            $column.Width = [System.Windows.GridLength]::new([double]$definition.Width, [System.Windows.GridUnitType]::$($definition.Kind))
            $grid.ColumnDefinitions.Add($column)
        }

        $mark = New-Object System.Windows.Controls.TextBlock
        $mark.Text = if ($row.Ok) { [char]0x2713 } else { [char]0x2717 }
        $mark.Foreground = if ($row.Ok) { '#7ec699' } else { '#e06c75' }
        $mark.FontFamily = 'Consolas'
        [System.Windows.Controls.Grid]::SetColumn($mark, 0)
        $grid.Children.Add($mark) | Out-Null

        $name = New-Object System.Windows.Controls.TextBlock
        $name.Text = $row.Name
        $name.FontFamily = 'Consolas'
        $name.VerticalAlignment = 'Center'
        [System.Windows.Controls.Grid]::SetColumn($name, 1)
        $grid.Children.Add($name) | Out-Null

        $detail = New-Object System.Windows.Controls.TextBlock
        $detail.Text = $row.Detail
        $detail.Opacity = 0.85
        $detail.VerticalAlignment = 'Center'
        $detail.TextTrimming = 'CharacterEllipsis'
        $detail.ToolTip = $row.Note
        [System.Windows.Controls.Grid]::SetColumn($detail, 2)
        $grid.Children.Add($detail) | Out-Null

        if (-not $row.Ok -and $row.Install) {
            $install = New-Object System.Windows.Controls.Button
            $install.Content = 'Install'
            $install.Width = 80
            $install.Height = 24
            $install.Margin = '6,0,0,0'
            $install.ToolTip = "winget install --id $($row.Install) -e"
            $install.Tag = $row
            $install.Add_Click({ Install-Requirement $this.Tag })
            [System.Windows.Controls.Grid]::SetColumn($install, 3)
            $grid.Children.Add($install) | Out-Null
        }

        if (-not $row.Ok -and $row.Url) {
            $page = New-Object System.Windows.Controls.Button
            $page.Content = 'Page'
            $page.Width = 60
            $page.Height = 24
            $page.Margin = '6,0,0,0'
            $page.ToolTip = $row.Url
            $page.Tag = $row.Url
            $page.Add_Click({ Start-Process $this.Tag | Out-Null })
            [System.Windows.Controls.Grid]::SetColumn($page, 4)
            $grid.Children.Add($page) | Out-Null
        }

        if (-not $row.Ok -and $row.Action) {
            $run = New-Object System.Windows.Controls.Button
            $run.Content = switch ($row.Action) { 'prepare' { 'Prepare' } 'dependencies' { 'Install' } 'build' { 'Build' } default { 'Run' } }
            $run.Width = 80
            $run.Height = 24
            $run.Margin = '6,0,0,0'
            $run.Tag = $row.Action
            $run.Add_Click({
                switch ($this.Tag) {
                    'prepare' { Start-Build @('-o') }
                    'dependencies' { Start-Build @('-DepsOnly') }
                    'build' { Start-Build @('-s') }
                }
            })
            [System.Windows.Controls.Grid]::SetColumn($run, 3)
            $grid.Children.Add($run) | Out-Null
        }

        $requirementsPanel.Children.Add($grid) | Out-Null
    }
}

<#
    Starts a build step: `dev/build-run.sh` with the flags that say which one.

    Only one at a time — two builds in one tree fight over `node_modules` and over the directory
    they pack into — so the button refuses when the lock is alive.
#>
function Start-Build([string[]]$flags) {
    $state = Get-BuildState
    if ($state.Running) {
        Add-Log "a build is already running (pid $($state.Pid))"
        return
    }
    Remove-Item $LogFile -ErrorAction SilentlyContinue
    $arguments = @('dev/build-run.sh') + $flags
    Add-Log "starting: bash $($arguments -join ' ')"
    Start-Process -FilePath 'bash' -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
    $bar.Value = 0
    $percentText.Text = '0%'
}

function Show-Log {
    if (-not (Test-Path $LogFile)) { return }
    $content = Get-Content $LogFile -Tail 200 -ErrorAction SilentlyContinue
    if (-not $content) { return }
    $text = ($content -join "`r`n")
    if ($text -ne $logBox.Text) {
        $logBox.Text = $text
        $logBox.ScrollToEnd()
    }
}

$ticks = 0
function Update-View {
    $script:ticks += 1
    # The requirements are re-read now and then, so a dependency installed in the terminal turns its
    # own row green without anyone pressing anything.
    if ($script:ticks % 5 -eq 1) { Show-Requirements }

    $state = Get-BuildState
    Show-Log

    $busy = $state.Running
    foreach ($button in @($buildButton, $prepareButton, $depsButton)) { $button.IsEnabled = -not $busy }
    $stopButton.IsEnabled = $busy

    if ($state.Progress) {
        $bar.Value = [math]::Min(100, [math]::Max(0, $state.Progress.percentage))
        $percentText.Text = "$([math]::Round($state.Progress.percentage))%"
        $remaining = if ($state.Progress.remainingSeconds -gt 0) { " - about $([math]::Floor($state.Progress.remainingSeconds / 60)):$('{0:d2}' -f ($state.Progress.remainingSeconds % 60)) left" } else { '' }
        $stageText.Text = "$($state.Progress.stage)$remaining"
        if ($state.Progress.done -eq 'failed') { $stageText.Text = 'the build failed - see the log above' }
        if ($state.Progress.done -eq 'ok') { $stageText.Text = 'the build finished - the editor is in VSCode-win32-x64' }
    } elseif ($busy) {
        $stageText.Text = 'starting...'
    } else {
        $stageText.Text = if (Test-Path $StatusFile) {
            $code = (Get-Content $StatusFile -Raw).Trim()
            if ($code -eq '0') { 'the last build finished well' } else { "the last build failed (exit code $code)" }
        } else { 'ready' }
    }
}

$buildButton.Add_Click({ Start-Build @('-s') })
$prepareButton.Add_Click({ Start-Build @('-o') })
$depsButton.Add_Click({ Start-Build @('-DepsOnly') })
$refreshButton.Add_Click({ Show-Requirements })

$stopButton.Add_Click({
    $state = Get-BuildState
    if (-not $state.Running) { return }
    $answer = [System.Windows.MessageBox]::Show(
        "Stop the build?`n`nThe tree may be left half-built, and the next build will redo what it was doing.",
        'PiCode - build', 'YesNo', 'Warning')
    if ($answer -eq 'Yes') {
        # The whole tree of processes: a build is a chain of shell, node and npm.
        & taskkill /PID $state.Pid /T /F | Out-Null
        Remove-Item $LockFile -ErrorAction SilentlyContinue
        Add-Log "stopped (pid $($state.Pid))"
        Update-View
    }
})

$openButton.Add_Click({
    $exe = Join-Path $PackDir 'PiCode.exe'
    if (Test-Path $exe) { Start-Process -FilePath $exe } else { Add-Log 'no editor built yet' }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({ Update-View })
$timer.Start()

Show-Requirements
Update-View

if ($SelfTest) {
    $names = @('Requirements', 'Log', 'Bar', 'Percent', 'Stage', 'Build', 'Stop', 'Open', 'Prepare', 'InstallDeps', 'Refresh')
    $missing = @()
    foreach ($name in $names) {
        if ($null -eq $window.FindName($name)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        Write-Output "window is missing: $($missing -join ', ')"
        exit 1
    }
    $rows = Get-Requirements
    # A missing requirement gets its own buttons (install, page, or the step that fixes it), and
    # the row for a present one gets none: this is the machine-checkable part of "it offers to
    # install what is missing".
    $buttons = 0
    foreach ($child in $requirementsPanel.Children) {
        foreach ($element in $child.Children) {
            if ($element -is [System.Windows.Controls.Button]) { $buttons += 1 }
        }
    }
    # A row can offer two things at once (install it, or read about it), so what is compared is the
    # number of buttons the missing rows would draw, not the number of rows.
    $expected = 0
    foreach ($row in $rows) {
        if ($row.Ok) { continue }
        foreach ($offered in @($row.Install, $row.Url, $row.Action)) {
            if ($offered) { $expected += 1 }
        }
    }
    Write-Output "window built: $($rows.Count) requirements, the three steps, the bar and the log are there"
    Write-Output "missing on this machine: $(($rows | Where-Object { -not $_.Ok } | ForEach-Object { $_.Name }) -join ', ')"
    Write-Output "buttons offered for what is missing: $buttons (expected $expected)"
    if ($buttons -ne $expected) {
        Write-Output 'the buttons do not match the missing requirements'
        exit 1
    }
    exit 0
}

$window.ShowDialog() | Out-Null
$timer.Stop()
