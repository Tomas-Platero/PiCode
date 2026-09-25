<#
.SYNOPSIS
    PiCode's build, in a small window: what is missing, a way to get it, and how much is left.

.DESCRIPTION
    The build needs things - a Node of the pinned version, Git (its Bash is what runs the build),
    jq, Python - and when one is missing the failure arrives minutes later inside a log nobody can
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
$PackDir = Join-Path $RepoRoot 'PiCode-Win32-x64'
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
    Each row carries the sentence for the case where it is *absent*: "Python 3 is missing" is
    something a person can act on, while "python3 - not installed" is exactly the kind of line this
    window was asked to stop showing. The versions, the command lines and the reason each one is
    needed live under Details.
#>
function Get-Requirements {
    $rows = New-Object System.Collections.Generic.List[object]

    $node = Get-CommandVersion 'node' '--version'
    $wanted = '24'
    $nvmrc = Join-Path $RepoRoot '.nvmrc'
    if (Test-Path $nvmrc) { $wanted = ((Get-Content $nvmrc -Raw).Trim() -split '\.')[0] }
    $nodeOk = $false
    if ($node) { $nodeOk = ((($node -replace '^v', '').Trim()) -split '\.')[0] -eq $wanted }
    $rows.Add([pscustomobject]@{
        Name = 'Node.js'
        Ok = $nodeOk
        Detail = if ($node) { "$node (the build wants $wanted)" } else { 'not found' }
        Missing = if ($node) { "Node.js $wanted is what the build uses; this machine has $node" } else { "Node.js $wanted is missing" }
        Install = 'OpenJS.NodeJS'
        Url = 'https://nodejs.org/en/download'
        Note = 'runs npm and the build tasks'
    })

    # Git and Git Bash are one install, so they are one row: the Bash is what actually runs the
    # build, and a machine with git but no bash would fail in a way nobody expects.
    $git = Get-CommandVersion 'git' '--version'
    $bash = [bool](Get-Command bash -ErrorAction SilentlyContinue)
    $rows.Add([pscustomobject]@{
        Name = 'Git for Windows'
        Ok = [bool]($git -and $bash)
        Detail = if ($git) { "$git$(if ($bash) { ', with Git Bash' } else { ', with no Bash' })" } else { 'not found' }
        Missing = if ($git) { 'Git Bash is missing, and it is what runs the build' } else { 'Git for Windows is missing' }
        Install = 'Git.Git'
        Url = 'https://git-scm.com/download/win'
        Note = 'Git, and the Bash the build runs in'
    })

    $jq = Get-CommandVersion 'jq' '--version'
    $rows.Add([pscustomobject]@{
        Name = 'jq'
        Ok = [bool]$jq
        Detail = if ($jq) { $jq } else { 'not found' }
        Missing = 'jq is missing'
        Install = 'jqlang.jq'
        Url = 'https://jqlang.github.io/jq/download/'
        Note = 'the pipeline reads the product and the patches with it'
    })

    $python = Get-CommandVersion 'python3' '--version'
    if (-not $python) { $python = Get-CommandVersion 'python' '--version' }
    $rows.Add([pscustomobject]@{
        Name = 'Python 3'
        Ok = [bool]$python
        Detail = if ($python) { $python } else { 'not found' }
        Missing = 'Python 3 is missing'
        Install = 'Python.Python.3.12'
        Url = 'https://www.python.org/downloads/windows/'
        Note = 'the native modules are compiled with it'
    })

    $drive = [System.IO.Path]::GetPathRoot($RepoRoot).TrimEnd(':', '\')
    $free = [math]::Round((Get-PSDrive -Name $drive).Free / 1GB, 1)
    $rows.Add([pscustomobject]@{
        Name = 'Room on disk'
        Ok = $free -ge 8
        Detail = "$free GB free on ${drive}:"
        Missing = "Only $free GB free: the build needs about 8 GB"
        Install = ''
        Url = ''
        Note = 'the source, its dependencies and the packed editor take a few GB'
    })

    # Not a tool: the one thing that has to be true for the pack to be able to replace the editor.
    $editorRunning = [bool](Get-Process -Name 'PiCode' -ErrorAction SilentlyContinue)
    $rows.Add([pscustomobject]@{
        Name = 'PiCode closed'
        Ok = -not $editorRunning
        Detail = if ($editorRunning) { 'PiCode is running' } else { 'nothing is using the folder it is built into' }
        Missing = 'Close PiCode first: the build replaces the folder the editor runs from'
        Install = ''
        Url = ''
        Note = 'Windows will not delete the files of a program that is running'
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
    foreach ($row in Get-Requirements) {
        $mark = if ($row.Ok) { 'OK  ' } else { 'NO  ' }
        Write-Output ("{0}{1,-18} {2}" -f $mark, $row.Name, $(if ($row.Ok) { $row.Detail } else { $row.Missing }))
    }
    $state = Get-BuildState
    $line = if ($state.Running) { "a build is running (pid $($state.Pid))" } else { 'no build is running' }
    if ($state.Progress) { $line += " - $([math]::Round($state.Progress.percentage))% - $($state.Progress.stage)" }
    Write-Output $line
    if (Test-Path $StatusFile) { Write-Output "last build exit code: $((Get-Content $StatusFile -Raw).Trim())" }
    exit 0
}

<#
    The window follows Windows: dark on a dark desktop, light on a light one. The colours are here and
    not in the markup because a wall of hex codes is not where a reader should look for the answer to
    "why is this box white", and because the log and the marks are drawn from code anyway.

    `PICODE_BUILD_WINDOW_THEME=light` (or `dark`) forces one, for a screenshot or for a machine whose
    setting is not what the person wants here. The editor's own theme is a different thing: this is a
    build tool, and it sits next to Windows, not inside PiCode.
#>
function Get-WindowPalette([bool]$light) {
    if ($light) {
        return @{
            Background = '#f6f6f6'; Foreground = '#1f1f1f'; Dim = '#5a5a5a'
            Good = '#137333'; Bad = '#b3261e'
            LogBackground = '#ffffff'; LogForeground = '#24292f'; LogBorder = '#d0d7de'
        }
    }
    return @{
        Background = '#1e1e1e'; Foreground = '#e6e6e6'; Dim = '#9a9a9a'
        Good = '#7ec699'; Bad = '#e06c75'
        LogBackground = '#141414'; LogForeground = '#cfcfcf'; LogBorder = '#333333'
    }
}

function Test-LightTheme {
    if ($env:PICODE_BUILD_WINDOW_THEME -eq 'light') { return $true }
    if ($env:PICODE_BUILD_WINDOW_THEME -eq 'dark') { return $false }
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
        return ((Get-ItemProperty -Path $key -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme -eq 1)
    } catch {
        return $false
    }
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="PiCode" Width="560" MinHeight="240" MaxHeight="780" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize"
        Background="#1e1e1e" Foreground="#e6e6e6" FontFamily="Segoe UI" FontSize="13">
  <Grid Margin="20">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- What is missing, in a person's words. Nothing at all when nothing is. -->
    <StackPanel Grid.Row="0" Name="Readiness" Margin="0,0,0,18"/>

    <StackPanel Grid.Row="1" Margin="0,0,0,16">
      <TextBlock Name="Headline" Text="ready" FontSize="17" FontWeight="SemiBold" TextWrapping="Wrap"/>
      <TextBlock Name="Explain" Margin="0,5,0,0" Opacity="0.72" TextWrapping="Wrap"/>
    </StackPanel>

    <StackPanel Grid.Row="2" Name="ProgressBlock" Margin="0,0,0,16" Visibility="Collapsed">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <ProgressBar Grid.Column="0" Name="Bar" Height="8" Minimum="0" Maximum="100"
                     Foreground="#3d8bfd" Background="#2f2f2f" BorderThickness="0"/>
        <TextBlock Grid.Column="1" Name="Percent" Text="0%" Width="48" Margin="12,0,0,0"
                   TextAlignment="Right" VerticalAlignment="Center" Opacity="0.75"/>
      </Grid>
      <TextBlock Name="StageLine" Margin="0,8,0,0" Opacity="0.85" TextWrapping="Wrap"/>
    </StackPanel>

    <StackPanel Grid.Row="3" Orientation="Horizontal">
      <Button Name="Primary" Content="Build PiCode" MinWidth="140" Height="32" FontWeight="SemiBold" Padding="16,0,16,0"/>
      <Button Name="Secondary" Content="Build again" MinWidth="120" Height="32" Margin="8,0,0,0" Padding="16,0,16,0" Visibility="Collapsed"/>
      <Button Name="Stop" Content="Stop" MinWidth="90" Height="32" Margin="8,0,0,0" Padding="16,0,16,0" Visibility="Collapsed"/>
    </StackPanel>

    <Button Grid.Row="4" Name="DetailsToggle" Content="Details" HorizontalAlignment="Left"
            Margin="0,14,0,0" Padding="14,6,14,6"/>

    <StackPanel Grid.Row="5" Name="DetailsPanel" Visibility="Collapsed" Margin="0,12,0,0">
      <StackPanel Name="Tools" Margin="0,0,0,10"/>
      <TextBox Name="Log" Height="230" IsReadOnly="True" FontFamily="Consolas" FontSize="12"
               Background="#141414" Foreground="#cfcfcf" BorderBrush="#333"
               VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>
    </StackPanel>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

# The title bar carries PiCode's own icon, the same drawing the distribution uses. If it cannot be
# read the window still opens: it is here to run a build, not to fail over its own title bar.
try {
    $iconPath = Join-Path $RepoRoot 'distribution\picode.ico'
    if (Test-Path $iconPath) { $window.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create($iconPath) }
} catch {
}

$readinessPanel = $window.FindName('Readiness')
$headlineText = $window.FindName('Headline')
$explainText = $window.FindName('Explain')
$progressBlock = $window.FindName('ProgressBlock')
$bar = $window.FindName('Bar')
$percentText = $window.FindName('Percent')
$stageLine = $window.FindName('StageLine')
$primaryButton = $window.FindName('Primary')
$secondaryButton = $window.FindName('Secondary')
$stopButton = $window.FindName('Stop')
$detailsToggle = $window.FindName('DetailsToggle')
$detailsPanel = $window.FindName('DetailsPanel')
$toolsPanel = $window.FindName('Tools')
$logBox = $window.FindName('Log')

$visible = [System.Windows.Visibility]::Visible
$collapsed = [System.Windows.Visibility]::Collapsed

$script:palette = Get-WindowPalette (Test-LightTheme)
$window.Background = $script:palette.Background
$window.Foreground = $script:palette.Foreground
$explainText.Foreground = $script:palette.Dim
$stageLine.Foreground = $script:palette.Dim
$percentText.Foreground = $script:palette.Dim
$logBox.Background = $script:palette.LogBackground
$logBox.Foreground = $script:palette.LogForeground
$logBox.BorderBrush = $script:palette.LogBorder

function Start-InTerminal([string]$title, [string]$command, [string]$workingDirectory) {
    $full = "title $title && cd /d `"$workingDirectory`" && $command"
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $full) | Out-Null
}

<#
    Installs one requirement. With winget it opens a terminal, so its own questions and its own
    progress are seen; without winget there is nothing to run, so the download page opens instead.
#>
function Install-Requirement($row) {
    if ($row.Install -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Add-Log "installing $($row.Name) with winget ($($row.Install))..."
        Start-InTerminal "PiCode - installing $($row.Name)" "winget install --id $($row.Install) -e --accept-source-agreements --accept-package-agreements" $RepoRoot
        return
    }
    if ($row.Url) { Start-Process $row.Url | Out-Null }
}

function Add-Log([string]$line) {
    $logBox.Text = "$($logBox.Text)`r`n[window] $line"
    $logBox.ScrollToEnd()
}

# ---------------------------------------------------------------------------
# The window
# ---------------------------------------------------------------------------

<#
    One line, with a mark and whatever has to be done about it. Used by both the readiness panel and
    the Details list, so a row looks the same wherever it appears.
#>
function New-Line([string]$mark, [string]$text, [string]$colour, $row, [string]$value) {
    $line = New-Object System.Windows.Controls.StackPanel
    $line.Orientation = 'Horizontal'
    $line.Margin = '0,0,0,6'

    $glyph = New-Object System.Windows.Controls.TextBlock
    $glyph.Text = $mark
    $glyph.Foreground = $colour
    $glyph.Width = 22
    $glyph.VerticalAlignment = 'Center'
    $line.Children.Add($glyph) | Out-Null

    $label = New-Object System.Windows.Controls.TextBlock
    $label.Text = $text
    $label.VerticalAlignment = 'Center'
    $label.TextWrapping = 'Wrap'
    $label.MaxWidth = 400
    if ($row -and $row.Note) { $label.ToolTip = $row.Note }
    $line.Children.Add($label) | Out-Null

    if ($value) {
        $valueText = New-Object System.Windows.Controls.TextBlock
        $valueText.Text = $value
        $valueText.Foreground = $script:palette.Dim
        $valueText.VerticalAlignment = 'Center'
        $valueText.Margin = '16,0,0,0'
        $line.Children.Add($valueText) | Out-Null
    }

    if ($row -and (-not $row.Ok) -and ($row.Install -or $row.Url)) {
        $button = New-Object System.Windows.Controls.Button
        $button.Content = if ($row.Install) { 'Install' } else { 'Get it' }
        $button.Height = 24
        $button.Padding = '12,0,12,0'
        $button.Margin = '14,0,0,0'
        $button.VerticalAlignment = 'Center'
        $button.Tag = $row
        $button.Add_Click({ Install-Requirement $this.Tag })
        $line.Children.Add($button) | Out-Null
    }

    return $line
}

<#
    Only what deviates gets a line. A tool that is installed and current is not news, and a list of
    four things that already work is the noise this window was asked to stop showing. What is missing
    gets its own sentence and the button that fixes it.
#>
function Show-Readiness($blockers) {
    $readinessPanel.Children.Clear()
    if ($blockers.Count -eq 0) {
        $readinessPanel.Children.Add((New-Line ([string][char]0x2713) 'Everything PiCode needs is on this machine.' $script:palette.Good $null)) | Out-Null
        return
    }
    $readinessPanel.Children.Add((New-Line ([string][char]0x2717) 'Something is missing before a build can run.' $script:palette.Bad $null)) | Out-Null
    foreach ($row in $blockers) {
        $readinessPanel.Children.Add((New-Line '' $row.Missing $script:palette.Foreground $row)) | Out-Null
    }
}

<# Everything that was checked, with its version: the answer to "what did it look at". #>
function Show-Tools($rows) {
    $toolsPanel.Children.Clear()
    foreach ($row in $rows) {
        $mark = if ($row.Ok) { [string][char]0x2713 } else { [string][char]0x2717 }
        $colour = if ($row.Ok) { $script:palette.Good } else { $script:palette.Bad }
        $line = New-Line $mark $row.Name $colour $null $row.Detail
        if ($row.Note) { $line.ToolTip = $row.Note }
        $toolsPanel.Children.Add($line) | Out-Null
    }
}

function Open-Editor {
    $exe = Join-Path $PackDir 'PiCode.exe'
    if (Test-Path $exe) {
        Start-Process -FilePath $exe | Out-Null
        return
    }
    Add-Log 'there is no editor built yet'
}

<#
    Starts the build. With no flags the pipeline fetches the source if it is not there, prepares it,
    installs, compiles, packs and stages - and skips whatever is already done, so this one button is
    also the way to resume after a failure. Nothing here is a step the owner has to choose.
#>
function Start-Build {
    if ($script:blockers.Count -gt 0) { return }
    $state = Get-BuildState
    if ($state.Running) { return }
    Remove-Item $LogFile -ErrorAction SilentlyContinue
    Add-Log 'starting the build'
    Start-Process -FilePath 'bash' -ArgumentList @('dev/build-run.sh') -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
    Update-View
}

<# Open or close what was checked and what the build said, and say so on the button. #>
function Set-Details([bool]$open) {
    $script:detailsOpen = $open
    $detailsPanel.Visibility = if ($open) { $visible } else { $collapsed }
    $detailsToggle.Content = if ($open) { 'Hide details' } else { 'Details' }
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

$script:ticks = 0
$script:blockers = @()
$script:primaryAction = 'build'
$script:detailsOpen = $false
$script:failedSeen = $false

<# Re-reads everything that was checked: a tool installed in the terminal turns green by itself. #>
function Read-Facts {
    $rows = Get-Requirements
    $script:blockers = @($rows | Where-Object { -not $_.Ok })
    Show-Readiness $script:blockers
    Show-Tools $rows
}

function Update-View {
    $script:ticks += 1
    if ($script:ticks % 5 -eq 1) { Read-Facts }

    $state = Get-BuildState
    Show-Log

    $built = Test-Path (Join-Path $PackDir 'PiCode.exe')
    $lastCode = if (Test-Path $StatusFile) { (Get-Content $StatusFile -Raw).Trim() } else { $null }
    $lastFailed = (-not $state.Running) -and $lastCode -and ($lastCode -ne '0')

    if ($state.Running) {
        $progressBlock.Visibility = $visible
        $headlineText.Text = 'Building PiCode'
        $explainText.Text = 'The build runs on its own: closing this window does not stop it.'
        $primaryButton.Visibility = $collapsed
        $secondaryButton.Visibility = $collapsed
        $stopButton.Visibility = $visible
        $stopButton.IsEnabled = $true
        if ($state.Progress) {
            $bar.Value = [math]::Min(100, [math]::Max(0, $state.Progress.percentage))
            $percentText.Text = "$([math]::Round($state.Progress.percentage))%"
            $stageLine.Text = $state.Progress.stage
            if ($state.Progress.remainingSeconds -gt 0) {
                $stageLine.Text += " - about $([math]::Floor($state.Progress.remainingSeconds / 60)):$('{0:d2}' -f ($state.Progress.remainingSeconds % 60)) left"
            }
        } else {
            $stageLine.Text = 'starting...'
        }
        return
    }

    $stopButton.Visibility = $collapsed
    $progressBlock.Visibility = $collapsed

    if ($lastFailed) {
        # Whatever it said is the only thing worth reading now, so it is opened rather than hinted at.
        $headlineText.Text = 'The build did not finish'
        $explainText.Text = 'What it said is below. Building it again keeps whatever was already done, so it does not start from the beginning.'
        if (-not $script:failedSeen) { Set-Details $true }
        $script:primaryAction = 'build'
        $primaryButton.Content = 'Build it again'
        $primaryButton.Visibility = $visible
        $secondaryButton.Visibility = $collapsed
    } elseif ($built) {
        $headlineText.Text = 'PiCode is ready'
        $explainText.Text = 'The editor has been built. Opening it is the usual thing from here.'
        $script:primaryAction = 'open'
        $primaryButton.Content = 'Open PiCode'
        $primaryButton.Visibility = $visible
        $secondaryButton.Content = 'Build it again'
        $secondaryButton.Visibility = $visible
    } else {
        $headlineText.Text = 'PiCode is not built yet'
        $explainText.Text = 'It fetches the source, installs the pieces and compiles the editor. The first time takes about half an hour.'
        $script:primaryAction = 'build'
        $primaryButton.Content = 'Build PiCode'
        $primaryButton.Visibility = $visible
        $secondaryButton.Visibility = $collapsed
    }

    $script:failedSeen = [bool]$lastFailed

    # A build that cannot work is not offered: the reason is already on the line above it.
    $primaryButton.IsEnabled = ($script:blockers.Count -eq 0)
    $primaryButton.ToolTip = if ($script:blockers.Count -eq 0) { $null } else { 'There is something missing: see the line above.' }
}

$primaryButton.Add_Click({
    if ($script:primaryAction -eq 'open') { Open-Editor } else { Start-Build }
})
$secondaryButton.Add_Click({ Start-Build })

$detailsToggle.Add_Click({ Set-Details (-not $script:detailsOpen) })

$stopButton.Add_Click({
    $state = Get-BuildState
    if (-not $state.Running) { return }
    $answer = [System.Windows.MessageBox]::Show(
        "Stop the build?`n`nThe tree may be left half-built, and the next build will redo what it was doing.",
        'PiCode', 'YesNo', 'Warning')
    if ($answer -eq 'Yes') {
        # The whole tree of processes: a build is a chain of shell, node and npm.
        & taskkill /PID $state.Pid /T /F | Out-Null
        Remove-Item $LockFile -ErrorAction SilentlyContinue
        Add-Log "stopped (pid $($state.Pid))"
        Update-View
    }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({ Update-View })
$timer.Start()

Read-Facts
Update-View

if ($SelfTest) {
    $names = @('Readiness', 'Headline', 'Explain', 'ProgressBlock', 'Bar', 'Percent', 'StageLine',
               'Primary', 'Secondary', 'Stop', 'DetailsToggle', 'DetailsPanel', 'Tools', 'Log')
    $missing = @()
    foreach ($name in $names) {
        if ($null -eq $window.FindName($name)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        Write-Output "window is missing: $($missing -join ', ')"
        exit 1
    }

    $rows = Get-Requirements
    $blockers = @($rows | Where-Object { -not $_.Ok })
    $problems = @()

    # The window is redrawn once a second, so a check that only looks at the first frame cannot see
    # anything that the ticking gets wrong: what is on screen after a few seconds is what he sees.
    for ($tick = 0; $tick -lt 4; $tick++) { Update-View }

    # One line for the verdict, one for each thing that deviates, and nothing for the rest.
    $expected = if ($blockers.Count -eq 0) { 1 } else { 1 + $blockers.Count }
    if ($readinessPanel.Children.Count -ne $expected) {
        $problems += "the readiness panel has $($readinessPanel.Children.Count) lines, expected $expected"
    }
    # Details lists every check, present or not.
    if ($toolsPanel.Children.Count -ne $rows.Count) {
        $problems += "Details lists $($toolsPanel.Children.Count) checks, expected $($rows.Count)"
    }
    # A build that cannot run is not offered.
    if (($blockers.Count -gt 0) -and $primaryButton.IsEnabled) {
        $problems += 'the button is enabled although something is missing'
    }
    if (($blockers.Count -eq 0) -and (-not $primaryButton.IsEnabled)) {
        $problems += 'the button is disabled although nothing is missing'
    }

    # What is on screen depends on what happened last, so the test asks for the shape that belongs
    # to this machine's state instead of one shape that would only be right on a fresh checkout.
    $state = Get-BuildState
    $built = Test-Path (Join-Path $PackDir 'PiCode.exe')
    $lastCode = if (Test-Path $StatusFile) { (Get-Content $StatusFile -Raw).Trim() } else { $null }
    $lastFailed = (-not $state.Running) -and $lastCode -and ($lastCode -ne '0')

    if (-not $state.Running) {
        $wanted = 'Build PiCode'
        if ($lastFailed) { $wanted = 'Build it again' } elseif ($built) { $wanted = 'Open PiCode' }
        if ($primaryButton.Content -ne $wanted) {
            $problems += "the button says '$($primaryButton.Content)', expected '$wanted'"
        }
        # A failure opens what it said; a clean state keeps the log out of the way.
        $wantOpen = [bool]$lastFailed
        $isOpen = [bool]$script:detailsOpen
        if ($isOpen -ne $wantOpen) {
            $problems += "the details panel is $(if ($isOpen) { 'open' } else { 'closed' }), expected $(if ($wantOpen) { 'open after a failure' } else { 'closed' })"
        }
    }

    Write-Output "window built: $($rows.Count) checks, $($blockers.Count) of them asking for something"
    Write-Output "state: $(if ($state.Running) { 'building' } elseif ($lastFailed) { 'the last build failed' } elseif ($built) { 'built' } else { 'not built yet' })"
    Write-Output "details after four ticks: $(if ($script:detailsOpen) { 'open' } else { 'closed' })"
    Write-Output "theme: $(if (Test-LightTheme) { 'light' } else { 'dark' })"

    # Both palettes have to be readable, not just the one this machine happens to use: the same file
    # runs on a collaborator's light desktop.
    function Get-Luminance([string]$hex) {
        $r = [Convert]::ToInt32($hex.Substring(1, 2), 16) / 255
        $g = [Convert]::ToInt32($hex.Substring(3, 2), 16) / 255
        $b = [Convert]::ToInt32($hex.Substring(5, 2), 16) / 255
        return (0.2126 * $r) + (0.7152 * $g) + (0.0722 * $b)
    }
    foreach ($light in @($true, $false)) {
        $p = Get-WindowPalette $light
        $name = if ($light) { 'light' } else { 'dark' }
        if ([math]::Abs((Get-Luminance $p.Background) - (Get-Luminance $p.Foreground)) -lt 0.5) {
            $problems += "the $name palette has too little contrast between the surface and the text"
        }
        if ([math]::Abs((Get-Luminance $p.LogBackground) - (Get-Luminance $p.LogForeground)) -lt 0.5) {
            $problems += "the $name palette has too little contrast inside the log"
        }
    }
    foreach ($problem in $problems) { Write-Output "PROBLEM: $problem" }
    if ($problems.Count -gt 0) { exit 1 }
    Write-Output 'nothing on screen that asks for nothing'
    exit 0
}

$window.ShowDialog() | Out-Null
$timer.Stop()
