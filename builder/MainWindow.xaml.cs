#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace PiCode.Builder;

/// <summary>
/// The window. It owns nothing but what is on screen: the build belongs to the scripts, and this asks
/// them how they are and shows the answer.
/// </summary>
public sealed partial class MainWindow : Window
{
	private const string BuilderVersion = "1.0.1";

	private readonly DispatcherTimer _timer = new();
	private readonly List<string> _notes = new();
	private BuildTarget _target = BuildTarget.Windows;
	private Requirements _requirements = new();
	private List<Requirement> _blockers = new();
	private Progress? _progress;
	private string? _buildLog;
	private int _ticks;
	private bool _failedSeen;
	private bool _missingSeen;

	public MainWindow()
	{
		InitializeComponent();

		// WinUI takes the size and the icon from code, not from the markup.
		AppWindow.Resize(new SizeInt32(1080, 720));

		// The title bar is drawn by Windows, not by us, so following the system would leave a white bar
		// over a dark window when Windows is light. It is painted to match instead.
		try
		{
			if (AppWindow.TitleBar is not null)
			{
				var bar = AppWindow.TitleBar;
				bar.BackgroundColor = Windows.UI.Color.FromArgb(255, 8, 11, 20);
				bar.ForegroundColor = Windows.UI.Color.FromArgb(255, 230, 230, 230);
				bar.InactiveBackgroundColor = Windows.UI.Color.FromArgb(255, 8, 11, 20);
				bar.InactiveForegroundColor = Windows.UI.Color.FromArgb(255, 150, 150, 150);
				bar.ButtonBackgroundColor = Windows.UI.Color.FromArgb(0, 0, 0, 0);
				bar.ButtonForegroundColor = Windows.UI.Color.FromArgb(255, 230, 230, 230);
				bar.ButtonHoverBackgroundColor = Windows.UI.Color.FromArgb(40, 255, 255, 255);
				bar.ButtonHoverForegroundColor = Windows.UI.Color.FromArgb(255, 255, 255, 255);
				bar.ButtonPressedBackgroundColor = Windows.UI.Color.FromArgb(60, 255, 255, 255);
				bar.ButtonPressedForegroundColor = Windows.UI.Color.FromArgb(255, 255, 255, 255);
			}
		}
		catch
		{
			// A window whose title bar cannot be painted is still a window.
		}
		FooterVersion.Text = $"PiCode Builder v{BuilderVersion}";
		FooterPath.Text = Pipeline.RepoRoot;
		RailArchitecture.Text = "Packaged as a portable folder for Windows.";
		ApplySourceState();
		UpdateSettings();

		try
		{
			var icon = Path.Combine(Pipeline.RepoRoot, "distribution", "picode.ico");
			if (File.Exists(icon))
			{
				AppWindow.SetIcon(icon);
			}
			// PiCode's own mark, the drawing the distribution ships. WinUI reads SVG, so the file is
			// used as it is and there is no second copy to keep in step.
			var logo = Path.Combine(Pipeline.RepoRoot, "distribution", "picode-icon.svg");
			if (File.Exists(logo))
			{
				Logo.Source = new SvgImageSource(new Uri(logo));
			}

			// The background is the owner's drawing, and it is optional on purpose: whoever clones the
			// repository does not need it to build anything.
			var background = Path.Combine(Pipeline.RepoRoot, "builder", "Assets", "picode-builder-background.svg");
			if (File.Exists(background))
			{
				BackgroundArt.Source = new SvgImageSource(new Uri(background));
			}
			else
			{
				BackgroundArt.Visibility = Visibility.Collapsed;
			}
		}
		catch
		{
			// The window is here to run a build, not to fail over its own decoration.
		}

		Nav.SelectedItem = Nav.MenuItems[0];
		GripArea.PointerPressed += OnGripPressed;
		PaintChannel();

		_timer.Interval = TimeSpan.FromSeconds(1);
		_timer.Tick += (_, _) => Refresh();
		_timer.Start();

		RefreshFacts();
		Refresh();
	}

	private const int WM_NCLBUTTONDOWN = 0x00A1;
	private const int HTBOTTOMRIGHT = 17;

	[DllImport("user32.dll")]
	private static extern IntPtr ReleaseCapture();

	[DllImport("user32.dll")]
	private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

	/// <summary>
	/// Starts a real resize. The window follows Windows and Windows no longer draws a grip, so this is
	/// drawn back - and a grip that does not grip would be a control that lies. Handing the press to the
	/// system's own border handling is how every custom handle does it.
	/// </summary>
	private void OnGripPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
	{
		var handle = WinRT.Interop.WindowNative.GetWindowHandle(this);
		ReleaseCapture();
		SendMessage(handle, WM_NCLBUTTONDOWN, (IntPtr)HTBOTTOMRIGHT, IntPtr.Zero);
	}

	private void OnNavChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
	{
		var tag = (args.SelectedItem as NavigationViewItem)?.Tag as string ?? "home";
		ShowPage(tag);
	}

	private void ShowPage(string tag)
	{
		PageHome.Visibility = tag == "home" ? Visibility.Visible : Visibility.Collapsed;
		PageCheck.Visibility = tag == "check" ? Visibility.Visible : Visibility.Collapsed;
		PageLogs.Visibility = tag == "logs" ? Visibility.Visible : Visibility.Collapsed;
		PageSettings.Visibility = tag == "settings" ? Visibility.Visible : Visibility.Collapsed;
	}

	/// <summary>
	/// Puts the window in step with where the source is: the hero says what will happen, the source card
	/// is only there when the tree is missing, and the Build button is only live when there is something
	/// to build.
	/// </summary>
	private void ApplySourceState()
	{
		var found = Pipeline.Found;
		HeroLine.Text = found
			? "Build PiCode for Windows: it compiles the editor, packs it and leaves it ready to run."
			: "PiCode is built from its source. None was found beside this program, so download it or point to a copy you already have.";
		SourceCard.Visibility = found ? Visibility.Collapsed : Visibility.Visible;
		SourceLine.Text = found
			? ""
			: "The builder needs the PiCode source tree. Without it there is nothing to compile.";
		BuildButton.IsEnabled = found;
	}

	/// <summary>The Settings page's own facts: where the source is, so it can be seen and changed.</summary>
	private void UpdateSettings()
	{
		if (SettingsRoot is null)
		{
			return;
		}
		SettingsRoot.Text = Pipeline.Found
			? Pipeline.RepoRoot
			: "No source folder yet. Download the source or point the window at a copy.";
	}

	/// <summary>
	/// The channel the build will seal: the branch the repository is on by default, or the one chose in
	/// the window. The branch is the owner's rule; the choice is the way back when there is no branch to
	/// read - a builder copied out of the repository on its own, or a download without history.
	/// </summary>
	private void PaintChannel()
	{
		var (_, branch) = Pipeline.ChannelForBranch();
		var chosen = Pipeline.ChannelSelection;
		var effective = Pipeline.Channel;
		var version = Pipeline.ProductVersion;
		if (chosen is null && branch.Length == 0)
		{
			ChannelLine.Text = "No branch to read. Pick the channel to build.";
			ChannelLine.Opacity = 0.6;
			FooterTarget.Text = "";
			return;
		}
		ChannelLine.Opacity = 1;
		ChannelLine.Text = chosen is not null
			? (branch.Length > 0 ? $"Building {chosen} (chosen here) · branch '{branch}'" : $"Building {chosen} (chosen here)")
			: effective is null
				? $"No channel · branch '{branch}' is not a release branch (builds plain PiCode)"
				: $"Building {effective} · branch '{branch}'";
		if (version.Length > 0)
		{
			ChannelLine.Text += $" · version {version}";
		}
		FooterTarget.Text = effective is null ? "No channel" : effective;
	}

	/// <summary>The channel picker changed: remember it and repaint everything that depends on it.</summary>
	private void OnChannelChanged(object sender, SelectionChangedEventArgs e)
	{
		if (ChannelLine is null)
		{
			return;
		}
		var choice = (ChannelCombo.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "Auto (from branch)";
		Pipeline.ChannelSelection = choice == "Auto (from branch)" ? null : choice;
		PaintChannel();
		BuildButtonText.Text = BuildLabel("");
		Refresh();
	}

	/// <summary>What the build button says, with the channel it is about to build.</summary>
	private string BuildLabel(string suffix)
	{
		var (_, branch) = Pipeline.ChannelForBranch();
		if (Pipeline.ChannelSelection is { } chosen)
		{
			return chosen == "stable" ? $"Build PiCode{suffix}" : $"Build PiCode {chosen}{suffix}";
		}
		if (branch.Length == 0)
		{
			return "Build PiCode" + suffix;
		}
		return Pipeline.Channel is null
			? $"Build PiCode ({branch}){suffix}"
			: (Pipeline.Channel == "stable" ? $"Build PiCode{suffix}" : $"Build PiCode {Pipeline.Channel}{suffix}");
	}

	/// <summary>
	/// A folder of its own for a fresh copy. Offered where the source is missing, so a builder carried
	/// out of the repository can still get to a build without anyone hunting for the URL.
	/// </summary>
	private async void OnDownloadSource(object sender, RoutedEventArgs e)
	{
		var folder = await PickFolderAsync("Choose an empty folder for the PiCode source");
		if (folder is null)
		{
			return;
		}
		SourceLine.Text = "Downloading PiCode source. This can take a few minutes…";
		DownloadSourceButton.IsEnabled = false;
		BrowseSourceButton.IsEnabled = false;
		var (ok, message) = await Task.Run(() => Pipeline.CloneSource(folder));
		DownloadSourceButton.IsEnabled = true;
		BrowseSourceButton.IsEnabled = true;
		if (ok && Pipeline.UseRoot(folder))
		{
			AppendNote("source downloaded: " + folder);
			Reinitialize();
			return;
		}
		SourceLine.Text = message;
	}

	/// <summary>Points the window at a copy of the source that is already on the machine.</summary>
	private async void OnBrowseSource(object sender, RoutedEventArgs e)
	{
		var folder = await PickFolderAsync("Choose the PiCode source folder (the one with dev and picode-source)");
		if (folder is null)
		{
			return;
		}
		if (Pipeline.UseRoot(folder))
		{
			if (SettingsSourceNote is not null)
			{
				SettingsSourceNote.Visibility = Visibility.Collapsed;
			}
			AppendNote("source folder set: " + folder);
			Reinitialize();
			return;
		}
		var message = "That folder is not a PiCode source tree (no dev/build.sh inside).";
		SourceLine.Text = message;
		if (SettingsSourceNote is not null)
		{
			SettingsSourceNote.Text = message;
			SettingsSourceNote.Visibility = Visibility.Visible;
		}
	}

	/// <summary>Opens the source in Explorer, so a folder named on the page can be looked at.</summary>
	private void OnOpenSource(object sender, RoutedEventArgs e)
	{
		if (!Pipeline.Found)
		{
			AppendNote("no source folder to open");
			return;
		}
		try
		{
			Process.Start(new ProcessStartInfo("explorer.exe", Pipeline.RepoRoot) { UseShellExecute = true });
		}
		catch (Exception error)
		{
			AppendNote("could not open the source folder: " + error.Message);
		}
	}

	/// <summary>
	/// Adopts a newly found tree: every part of the window that was read from the old one is read again,
	/// so nothing keeps saying "not here" over a source that is now right there.
	/// </summary>
	private void Reinitialize()
	{
		FooterPath.Text = Pipeline.RepoRoot;
		ApplySourceState();
		UpdateSettings();
		SelectChannelInCombo();
		PaintChannel();
		RefreshFacts();
		Refresh();
	}

	/// <summary>Puts the picker in step with the channel already in force, without firing the handler.</summary>
	private void SelectChannelInCombo()
	{
		var wanted = Pipeline.ChannelSelection is { } chosen ? chosen : "Auto (from branch)";
		foreach (var item in ChannelCombo.Items.OfType<ComboBoxItem>())
		{
			if ((item.Content?.ToString() ?? "") == wanted)
			{
				ChannelCombo.SelectedItem = item;
				return;
			}
		}
	}

	/// <summary>A folder picker, wired to this window so it appears in front of it and not behind.</summary>
	private async Task<string?> PickFolderAsync(string commitButtonText)
	{
		try
		{
			var picker = new Windows.Storage.Pickers.FolderPicker
			{
				SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.ComputerFolder,
				CommitButtonText = commitButtonText,
			};
			picker.FileTypeFilter.Add("*");
			var handle = WinRT.Interop.WindowNative.GetWindowHandle(this);
			WinRT.Interop.InitializeWithWindow.Initialize(picker, handle);
			var folder = await picker.PickSingleFolderAsync();
			return folder?.Path;
		}
		catch (Exception error)
		{
			App.WriteCrashLog("PickFolderAsync: " + error);
			return null;
		}
	}

	/// <summary>
	/// The one button. While a build runs it stops it, and the rest of the time it starts one - a button
	/// that keeps its name and needs a second button somewhere else for the reverse is two buttons where
	/// one decision would do.
	/// </summary>
	private void OnPrimary(object sender, RoutedEventArgs e)
	{
		if (Pipeline.IsBuildRunning(_target))
		{
			OnStop(sender, e);
			return;
		}
		StartBuild();
	}

	private void StartBuild()
	{
		App.WriteCrashLog($"StartBuild: blockers={_blockers.Count}, running={Pipeline.IsBuildRunning(_target)}");
		try
		{
			if (_blockers.Count > 0)
			{
				AppendNote($"cannot build: {_blockers.Count} blocker(s) - see System Check");
				Nav.SelectedItem = Nav.MenuItems[1];
				return;
			}
			if (Pipeline.IsBuildRunning(_target))
			{
				AppendNote("a build is already running");
				Nav.SelectedItem = Nav.MenuItems[2];
				return;
			}
			AppendNote("starting the build");
			BuildingCard.Visibility = Visibility.Visible;
			BusyRing.IsActive = true;
			Bar.Value = 0;
			Percent.Text = "0%";
			App.WriteCrashLog("StartBuild: calling Pipeline.StartBuild");
			// The channel is not here: Pipeline reads the picker's own choice and passes it, so a
			// channel set in one place is a channel in the build. Only the switches travel as pairs.
			var extraEnv = new Dictionary<string, string>();
			// The installer switch travels set both ways, never left to the script's default: on says
			// skip it, off says build it. The pipeline's own default is "skip" (a local build is
			// portable-only; only the release asks for the installer), so an off toggle that set
			// nothing would silently drop the installer the user asked for.
			if (SkipInstallerToggle is not null)
			{
				extraEnv["PICODE_SKIP_INSTALLER"] = SkipInstallerToggle.IsOn ? "yes" : "no";
			}
			if (IncrementalToggle is not null && IncrementalToggle.IsOn)
			{
				extraEnv["PICODE_INCREMENTAL"] = "1";
			}
			if (BuildCliToggle is not null && !BuildCliToggle.IsOn)
			{
				extraEnv["PICODE_BUILD_CLI"] = "no";
			}
			var started = Pipeline.StartBuild(_target, extraEnv);
			App.WriteCrashLog($"StartBuild: Pipeline.StartBuild returned {started}");
			if (!started)
			{
				AppendNote("the build could not be started (see the crash log)");
				BuildingCard.Visibility = Visibility.Collapsed;
				BusyRing.IsActive = false;
				Refresh();
				return;
			}
			Refresh();
		}
		catch (Exception ex)
		{
			App.WriteCrashLog("StartBuild EXCEPTION: " + ex);
			AppendNote("build failed to start: " + ex.Message);
		}
	}

	private async void OnClean(object sender, RoutedEventArgs e)
	{
		var answer = new ContentDialog
		{
			Title = "Clean the built files?",
			Content = $"Removes the built editor ({Path.GetFileName(Pipeline.PackDirectory(_target))}) and the last build's verdict. The source tree is kept, so the next build reuses it and does not download again.",
			PrimaryButtonText = "Clean",
			CloseButtonText = "Cancel",
			XamlRoot = Content.XamlRoot,
		};
		if (await answer.ShowAsync() != ContentDialogResult.Primary)
		{
			return;
		}
		var (ok, message) = Pipeline.CleanBuild(_target);
		AppendNote(message);
		Refresh();
	}

	private void OnStop(object sender, RoutedEventArgs e)
	{
		if (!Pipeline.IsBuildRunning(_target))
		{
			Pipeline.ClearStaleLock();
			Refresh();
			return;
		}
		Pipeline.StopBuild(_target);
		AppendNote("stop asked for: the tree may be left half-built");
		Refresh();
	}

	/// <summary>Everything that was checked, with the button that fixes what is missing.</summary>
	private void RefreshFacts()
	{
		_requirements = Pipeline.ReadRequirements(_target);
		_blockers = _requirements.Checks.Where(check => !check.Ok && !check.Optional).ToList();

		Checks.Children.Clear();

		var required = _requirements.Required > 0 ? _requirements.Required : _requirements.Checks.Length;
		// No checks at all is not "everything is satisfied": it means the list could not be read, and
		// saying otherwise offered a Build button that could not do anything.
		if (_requirements.Checks.Length == 0)
		{
			RailCheckCount.Text = "";
			Checks.Children.Add(Note("The checks could not be read: the repository was not found from where this program is running."));
			BuildButton.IsEnabled = false;
			BuildButtonText.Text = "Build PiCode (no repository)";
			return;
		}

		RailCheckCount.Text = $"{required - _blockers.Count} / {required} ready";

		foreach (var check in _requirements.Checks)
		{
			Checks.Children.Add(CheckRow(check, withButton: true));
		}


		if (_blockers.Count > 0 && !_missingSeen)
		{
			_missingSeen = true;
			Nav.SelectedItem = Nav.MenuItems[1];
		}

		// A build that cannot work is not offered, and the reason is on the page that lists it.
		BuildButton.IsEnabled = _blockers.Count == 0;
		BuildButtonText.Text = _blockers.Count > 0 ? BuildLabel(" (something is missing)") : BuildLabel("");
	}

	/// <summary>A line that only says something, for when there is nothing to list.</summary>
	private static TextBlock Note(string text) => new()
	{
		Text = text,
		TextWrapping = TextWrapping.Wrap,
		Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
	};

	/// <summary>One check: a mark, its name, what was found, and - where it is fixed - its button.</summary>
	private UIElement CheckRow(Requirement check, bool withButton)
	{
		var line = new Grid { ColumnSpacing = 10 };
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

		// The tool's own mark where there is one, and the plain tick where there is not: several of these
		// tools are trademarks with no freely distributable icon, and pretending otherwise would show a
		// wrong logo. The tooltip still names what was found.
		var brand = Pipeline.BrandIcon(check.Icon);
		if (brand is not null)
		{
			var icon = new Image { Width = 16, Height = 16, VerticalAlignment = VerticalAlignment.Center };
			icon.Source = new SvgImageSource(new Uri(brand));
			Grid.SetColumn(icon, 0);
			line.Children.Add(icon);
		}
		else
		{
			var mark = new TextBlock
			{
				Text = check.Ok ? "\u2713" : "\u2717",
				VerticalAlignment = VerticalAlignment.Center,
				Foreground = (Brush)Application.Current.Resources[
					check.Ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"],
			};
			Grid.SetColumn(mark, 0);
			line.Children.Add(mark);
		}

		var name = new TextBlock { Text = check.Name, VerticalAlignment = VerticalAlignment.Center };
		if (!string.IsNullOrEmpty(check.Note))
		{
			ToolTipService.SetToolTip(name, check.Note);
		}
		Grid.SetColumn(name, 1);
		line.Children.Add(name);

		var value = new TextBlock
		{
			Text = check.Ok ? check.Found : check.Missing,
			VerticalAlignment = VerticalAlignment.Center,
			TextWrapping = TextWrapping.Wrap,
			Foreground = (Brush)Application.Current.Resources[
				check.Ok ? "TextFillColorSecondaryBrush" : "SystemFillColorCriticalBrush"],
		};
		Grid.SetColumn(value, 2);
		line.Children.Add(value);

		if (withButton && !check.Ok && (!string.IsNullOrEmpty(check.Install) || !string.IsNullOrEmpty(check.Url)))
		{
			var install = new Button
			{
				Content = string.IsNullOrEmpty(check.Install) ? "Get it" : "Install",
				VerticalAlignment = VerticalAlignment.Center,
			};
			var captured = check;
			install.Click += (_, _) => Pipeline.Install(captured);
			Grid.SetColumn(install, 3);
			line.Children.Add(install);
		}

		return line;
	}

	/// <summary>
	/// The build's steps as a timeline: a tick for what is done, a dot and a sentence for what is
	/// happening, a circle for what is left. Everything before the step it is on is done, whether it is
	/// still working or stopped there.
	/// </summary>
	private void ShowSteps(Progress? progress, bool running)
	{
		Steps.Children.Clear();
		var stages = progress?.Stages ?? Array.Empty<Step>();
		if (stages.Length == 0)
		{
			foreach (var text in new[]
			{
				"No build yet. Press Build PiCode and its steps appear here.",
			})
			{
				Steps.Children.Add(new TextBlock
				{
					Text = text,
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
					TextWrapping = TextWrapping.Wrap,
				});
			}
			return;
		}

		var done = 0;
		var current = -1;
		var failed = false;
		if (progress is not null)
		{
			if (progress.Done == "ok")
			{
				done = stages.Length;
			}
			else
			{
				current = progress.StageIndex;
				failed = progress.Done == "failed";
				done = current;
				if (!running && !failed)
				{
					done = 0;
					current = -1;
				}
			}
		}

		for (var index = 0; index < stages.Length; index++)
		{
			var stage = stages[index];
			var mark = "\u25CB";
			var brush = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
			var detail = "";
			var bold = false;
			var connector = (Brush)Application.Current.Resources["DividerStrokeColorDefaultBrush"];

			if (index < done)
			{
				mark = "\u2713";
				brush = (Brush)Application.Current.Resources["SystemFillColorSuccessBrush"];
			}
			else if (index == current)
			{
				mark = failed ? "\u2717" : "\u25CF";
				brush = (Brush)Application.Current.Resources[
					failed ? "SystemFillColorCriticalBrush" : "TextFillColorPrimaryBrush"];
				bold = true;
				if (running)
				{
					detail = stage.Detail;
				}
			}

			// The line down the left is the timeline: a border on each row, which costs nothing and
			// joins up without a control per gap.
			var row = new Border
			{
				BorderThickness = new Thickness(2, 0, 0, 0),
				BorderBrush = connector,
				Padding = new Thickness(12, 6, 0, 6),
			};
			var inner = new StackPanel { Spacing = 2 };
			var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };

			// The mark sits in a circle, which is what the reference shows and what makes a list of
			// steps read as a path rather than as rows.
			var badge = new Border
			{
				Width = 22,
				Height = 22,
				CornerRadius = new CornerRadius(11),
				BorderThickness = new Thickness(1),
				BorderBrush = brush,
				Background = (Brush)Application.Current.Resources[
					index < done ? "SystemFillColorSuccessBackgroundBrush" : "SubtleFillColorTransparentBrush"],
				VerticalAlignment = VerticalAlignment.Center,
			};
			badge.Child = new TextBlock
			{
				Text = mark,
				FontSize = 12,
				Foreground = brush,
				HorizontalAlignment = HorizontalAlignment.Center,
				VerticalAlignment = VerticalAlignment.Center,
			};
			header.Children.Add(badge);

			header.Children.Add(new TextBlock
			{
				Text = stage.Label,
				Foreground = brush,
				VerticalAlignment = VerticalAlignment.Center,
				FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
			});
			inner.Children.Add(header);
			if (!string.IsNullOrEmpty(detail))
			{
				inner.Children.Add(new TextBlock
				{
					Text = detail,
					Margin = new Thickness(24, 0, 0, 0),
					TextWrapping = TextWrapping.Wrap,
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
				});
			}
			else if (!string.IsNullOrEmpty(stage.Detail))
			{
				ToolTipService.SetToolTip(row, stage.Detail);
			}
			row.Child = inner;
			Steps.Children.Add(row);
		}
	}

	/// <summary>What the last build did, and when. No per-step times: the module does not measure them.</summary>
	/// <summary>The mark and the word: what the last run did, or what the folder says happened.</summary>
	private static StackPanel VerdictLine(bool ok, string word) => new()
	{
		Orientation = Orientation.Horizontal,
		Spacing = 8,
		Children =
		{
			new TextBlock
			{
				Text = ok ? "\u2713" : "\u2717",
				Foreground = (Brush)Application.Current.Resources[
					ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"],
			},
			new TextBlock { Text = word },
		},
	};

	private void ShowLastBuild(string? exit, Progress? progress)
	{
		LastBuild.Children.Clear();

		// What exists outranks what a file says. The verdict file can be missing - cleaned, or never
		// written by a run that died hard - while the editor it produced is sitting right there, and a
		// card that says "nothing built" over a built editor is lying about the thing it exists to
		// report.
		if (exit is null && progress is null)
		{
			if (Pipeline.EditorExists(_target))
			{
				LastBuild.Children.Add(VerdictLine(true, "Built"));
				LastBuild.Children.Add(new TextBlock
				{
					Text = Path.GetFileName(Pipeline.EditorExecutable(_target)) + " is in " + Path.GetFileName(Pipeline.PackDirectory(_target)),
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
				});
			}
			else
			{
				LastBuild.Children.Add(new TextBlock
				{
					Text = "Nothing built on this machine yet.",
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
				});
			}
			return;
		}

		var ok = exit == "0" || (exit is null && Pipeline.EditorExists(_target));
		LastBuild.Children.Add(VerdictLine(ok, ok ? "Successful" : "Did not finish"));

		try
		{
			var status = Path.Combine(Pipeline.RepoRoot, ".scratch", "build.status");
			if (File.Exists(status))
			{
				var when = File.GetLastWriteTime(status);
				var took = progress is not null && progress.ElapsedSeconds > 0
					? $" - {Clock(progress.ElapsedSeconds)}"
					: "";
				LastBuild.Children.Add(new TextBlock
				{
					Text = $"{when:yyyy-MM-dd HH:mm}{took}",
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
				});
			}
		}
		catch (IOException)
		{
		}

		LastBuild.Children.Add(new TextBlock
		{
			Text = Pipeline.EditorExists(_target) ? Path.GetFileName(Pipeline.EditorExecutable(_target)) + " is in " + Path.GetFileName(Pipeline.PackDirectory(_target)) : "No editor in place yet",
			TextWrapping = TextWrapping.Wrap,
			Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
		});
	}

	private void AppendNote(string line)
	{
		_notes.Add("[window] " + line);
		if (_notes.Count > 40)
		{
			_notes.RemoveAt(0);
		}
		RenderLog();
	}

	/// <summary>What the window itself had to say, above what the build said.</summary>
	private void RenderLog()
	{
		var build = _buildLog ?? "";
		var text = _notes.Count == 0 ? build : string.Join(Environment.NewLine, _notes) + Environment.NewLine + build;
		if (text != LogBox.Text)
		{
			LogBox.Text = text;
		}
	}

	private void Refresh()
	{
		_ticks++;

		// The checks are process launches, so they are asked for now and then; the lock is a file, and
		// cheap enough to look at every second.
		if (_ticks % 5 == 1)
		{
			RefreshFacts();
		}

		var running = Pipeline.IsBuildRunning(_target);
		var exit = Pipeline.LastExitCode(_target);
		var failed = !running && exit is not null && exit != "0";

		if (running)
		{
			BuildingCard.Visibility = Visibility.Visible;
			BusyRing.IsActive = true;
			BuildButtonText.Text = "Stop build";
			BuildButton.IsEnabled = true;

			_progress = Pipeline.ReadProgress(_target);
			if (_progress is not null)
			{
				Bar.Value = Math.Clamp(_progress.Percentage, 0, 100);
				Percent.Text = $"{Math.Round(_progress.Percentage)}%";
				BuildHeadline.Text = "Building PiCode";
				StageLine.Text = _progress.Stage;
				Timing.Text = $"{Clock(_progress.ElapsedSeconds)} in" +
					(_progress.RemainingSeconds > 0 ? $", about {Clock(_progress.RemainingSeconds)} left" : "");
			}
			else
			{
				BusyRing.IsActive = true;
				Percent.Text = "";
				StageLine.Text = "starting...";
				Timing.Text = "";
			}
			ShowSteps(_progress, true);
		}
		else
		{
			BuildButtonText.Text = _blockers.Count == 0 ? BuildLabel("") : BuildLabel(" (something is missing)");
			BuildButton.IsEnabled = _blockers.Count == 0;

			// The steps of the last build, shown the same way the Last build card reports it: a build
			// that ran - this session or an earlier one, started here or from a terminal - still left
			// its log and, when it succeeded, its editor. Hiding its steps while the card reports the
			// build is the contradiction this removes. What is still refused is a finished bar over a
			// folder with no editor: a verdict that says "built" with nothing there is stale, and only
			// a failure (where the steps show where it stopped) is worth drawing without an editor.
			var hasEditor = Pipeline.EditorExists(_target);
			if (!hasEditor && exit is null or "0")
			{
				BuildingCard.Visibility = Visibility.Collapsed;
				BusyRing.IsActive = false;
				Bar.Value = 0;
				Percent.Text = "";
				StageLine.Text = "";
				Timing.Text = "";
				BuildHeadline.Text = "";
				ShowSteps(null, false);
				// No editor and no failure: both cards agree here. Passing the verdict through would
				// let a status that says "built" claim success over a folder that no longer has it.
				ShowLastBuild(null, null);
				return;
			}

			_progress = Pipeline.ReadProgress(_target);
			if (_progress is not null)
			{
				BuildingCard.Visibility = Visibility.Visible;
				BusyRing.IsActive = false;
				var value = _progress.Done == "ok" ? 100 : Math.Clamp(_progress.Percentage, 0, 100);
				Bar.Value = value;
				Percent.Text = $"{Math.Round(value)}%";
				BuildHeadline.Text = _progress.Done switch
				{
					"ok" => "The build finished",
					"failed" => "The build did not finish",
					_ => "The last build",
				};
				StageLine.Text = _progress.Done switch
				{
					"ok" => "The editor is in " + Path.GetFileName(Pipeline.PackDirectory(_target)) + ".",
					"failed" => "It stopped at the step marked below. What it said is in Build Logs.",
					_ => _progress.Stage,
				};
				Timing.Text = $"{Clock(_progress.ElapsedSeconds)} in";
			}
			else
			{
				BuildingCard.Visibility = Visibility.Collapsed;
			}
			ShowSteps(_progress, false);
		}

		ShowLastBuild(exit, _progress);
		_buildLog = Pipeline.ReadLog(_target, 400);
		RenderLog();

		// Whatever a failed build said is worth reading then, so it is opened rather than hinted at.
		if (failed && !_failedSeen)
		{
			_failedSeen = true;
			var reason = exit switch
			{
				"3" => "a build is already running (stale lock?)",
				"4" => "PiCode is running — close it first, the pack cannot delete its folder",
				_ => $"exit code {exit}",
			};
			AppendNote($"build did not finish: {reason}");
			Nav.SelectedItem = Nav.MenuItems[2];
		}
	}

	private static string Clock(int seconds)
	{
		if (seconds <= 0)
		{
			return "0:00";
		}
		return $"{seconds / 60}:{seconds % 60:d2}";
	}
}
