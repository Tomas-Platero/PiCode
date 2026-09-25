using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics;
using System.Runtime.InteropServices;

namespace PiCode.Builder;

/// <summary>
/// The window. It owns nothing but what is on screen: the build belongs to the scripts, and this asks
/// them how they are and shows the answer.
/// </summary>
public sealed partial class MainWindow : Window
{
	private const string BuilderVersion = "1.0.0";

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
	private bool _linuxAvailable;
	private string _linuxReason = "";

	public MainWindow()
	{
		InitializeComponent();

		// WinUI takes the size and the icon from code, not from the markup.
		AppWindow.Resize(new SizeInt32(1080, 720));
		FooterVersion.Text = $"PiCode Builder v{BuilderVersion}";
		FooterPath.Text = Pipeline.RepoRoot;
		HeroLine.Text = "Build PiCode for Windows, or for Linux through WSL. Same pipeline either way.";
		ArchitectureLine.Text = $"Architecture: Win32 x64 (the pipeline builds win-x64 and nothing else)";
		RailArchitecture.Text = "Win32 x64";

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

		PaintTargets();
		_linuxAvailable = Pipeline.LinuxAvailable(out _linuxReason);
		WslLine.Text = _linuxAvailable ? "WSL: a distribution is ready." : "WSL: " + _linuxReason;

		Nav.SelectedItem = Nav.MenuItems[0];
		GripArea.PointerPressed += OnGripPressed;

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

	private void OnTargetClicked(object sender, RoutedEventArgs e)
	{
		var tag = (sender as FrameworkElement)?.Tag as string;
		_target = tag == "linux" ? BuildTarget.Linux : BuildTarget.Windows;
		PaintTargets();
		_ticks = 0;
		RefreshFacts();
		Refresh();
	}

	/// <summary>
	/// The two buttons say which machine the build runs on, and the chosen one is the filled one. The
	/// setting lives here and nowhere else: a second control for the same thing is two things to keep
	/// in step, and one of them always ends up out of step.
	/// </summary>
	private void PaintTargets()
	{
		var windows = _target == BuildTarget.Windows;
		TargetWindowsButton.Style = (Style)Application.Current.Resources[windows ? "AccentButtonStyle" : "DefaultButtonStyle"];
		TargetLinuxButton.Style = (Style)Application.Current.Resources[windows ? "DefaultButtonStyle" : "AccentButtonStyle"];
		TargetLine.Text = windows ? "Windows" : "Linux through WSL";
		RailArchitecture.Text = windows ? "Win32 x64" : "the same pipeline, in WSL";
		FooterTarget.Text = windows ? "Windows" : "Linux (WSL)";
	}

	private void OnBuild(object sender, RoutedEventArgs e)
	{
		if (_blockers.Count > 0 || Pipeline.IsBuildRunning(_target))
		{
			return;
		}
		if (_target == BuildTarget.Linux && !_linuxAvailable)
		{
			AppendNote("Linux builds need WSL with a distribution: " + _linuxReason);
			return;
		}
		AppendNote("starting the build");
		BuildingCard.Visibility = Visibility.Visible;
		BusyRing.IsActive = true;
		Bar.Value = 0;
		Percent.Text = "0%";
		Pipeline.StartBuild(_target);
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
		foreach (var check in _requirements.Checks)
		{
			Checks.Children.Add(CheckRow(check, withButton: true));
		}

		RailChecks.Children.Clear();
		foreach (var check in _requirements.Checks)
		{
			RailChecks.Children.Add(CheckRow(check, withButton: false));
		}
		var required = _requirements.Required > 0 ? _requirements.Required : _requirements.Checks.Length;
		RailCheckCount.Text = $"{required - _blockers.Count} / {required} ready";
		RailCheckSummary.Visibility = _blockers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
		RailCheckSummaryText.Text = _blockers.Count == 0
			? "All requirements satisfied"
			: $"{_blockers.Count} thing(s) need attention: open System Check";

		if (_blockers.Count > 0 && !_missingSeen)
		{
			_missingSeen = true;
			Nav.SelectedItem = Nav.MenuItems[1];
		}

		// A build that cannot work is not offered, and the reason is on the page that lists it.
		BuildButton.IsEnabled = _blockers.Count == 0 && (_target == BuildTarget.Windows || _linuxAvailable);
		BuildButtonText.Text = _blockers.Count > 0 ? "Build PiCode (something is missing)" : "Build PiCode";
	}

	/// <summary>One check: a mark, its name, what was found, and - where it is fixed - its button.</summary>
	private UIElement CheckRow(Requirement check, bool withButton)
	{
		var line = new Grid { ColumnSpacing = 10 };
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
		line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

		var mark = new TextBlock
		{
			Text = check.Ok ? "\u2713" : "\u2717",
			VerticalAlignment = VerticalAlignment.Center,
			Foreground = (Brush)Application.Current.Resources[
				check.Ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"],
		};
		Grid.SetColumn(mark, 0);
		line.Children.Add(mark);

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
			var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
			header.Children.Add(new TextBlock { Text = mark, Width = 16, Foreground = brush });
			header.Children.Add(new TextBlock
			{
				Text = stage.Label,
				Foreground = brush,
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
	private void ShowLastBuild(string? exit, Progress? progress)
	{
		LastBuild.Children.Clear();
		if (exit is null && progress is null)
		{
			LastBuild.Children.Add(new TextBlock
			{
				Text = "Nothing built on this machine yet.",
				Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
			});
			return;
		}

		var ok = exit == "0";
		var mark = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
		mark.Children.Add(new TextBlock
		{
			Text = ok ? "\u2713" : "\u2717",
			Foreground = (Brush)Application.Current.Resources[ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"],
		});
		mark.Children.Add(new TextBlock { Text = ok ? "Successful" : "Did not finish" });
		LastBuild.Children.Add(mark);

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
			Text = Pipeline.EditorExists ? "PiCode.exe is in PiCode-Win32-x64" : "No editor in place yet",
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
			StopButton.Visibility = Visibility.Visible;
			BuildButton.IsEnabled = false;

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
			StopButton.Visibility = Visibility.Collapsed;
			BuildButton.IsEnabled = _blockers.Count == 0 && (_target == BuildTarget.Windows || _linuxAvailable);

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
					"ok" => "The editor is in PiCode-Win32-x64.",
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
