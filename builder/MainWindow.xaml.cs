using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace PiCode.Builder;

/// <summary>
/// The window. It owns nothing but what is on screen: the build belongs to the scripts, and this asks
/// them how they are and shows the answer.
/// </summary>
public sealed partial class MainWindow : Window
{
	private const string BuilderVersion = "1.0.0";

	private readonly DispatcherTimer _timer = new();
	private BuildTarget _target = BuildTarget.Windows;

	private Requirements _requirements = new();
	private List<Requirement> _blockers = new();
	private Progress? _progress;
	private int _ticks;
	private bool _failedSeen;
	private bool _linuxAvailable;
	private string _linuxReason = "";

	public MainWindow()
	{
		InitializeComponent();

		TitleText.Text = $"PiCode Builder v{BuilderVersion}";
		TargetBox.SelectedIndex = 0;

		// WinUI takes the size from code, not from the markup.
		AppWindow.Resize(new SizeInt32(980, 700));
		Title = "PiCode Builder";

		_linuxAvailable = Pipeline.LinuxAvailable(out _linuxReason);

		_timer.Interval = TimeSpan.FromSeconds(1);
		_timer.Tick += (_, _) => Refresh();
		_timer.Start();

		RefreshFacts();
		Refresh();
	}

	private void OnTargetChanged(object sender, SelectionChangedEventArgs e)
	{
		_target = TargetBox.SelectedIndex == 1 ? BuildTarget.Linux : BuildTarget.Windows;
		_ticks = 0;
		RefreshFacts();
		Refresh();
	}

	private void OnBuild(object sender, RoutedEventArgs e)
	{
		if (_blockers.Count > 0 || Pipeline.IsBuildRunning(_target))
		{
			return;
		}
		if (_target == BuildTarget.Linux && !_linuxAvailable)
		{
			AppendLog("Linux builds need WSL with a distribution: " + _linuxReason);
			return;
		}
		AppendLog("starting the build");
		BuildPanel.Visibility = Visibility.Visible;
		Bar.Value = 0;
		Percent.Text = "0%";
		Timing.Text = "starting...";
		Pipeline.StartBuild(_target);
		Refresh();
	}

	private void OnOpen(object sender, RoutedEventArgs e)
	{
		if (Pipeline.EditorExists)
		{
			Pipeline.OpenEditor();
			return;
		}
		AppendLog("there is no editor built yet");
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
		AppendLog("stop asked for: the tree may be left half-built");
		Refresh();
	}

	/// <summary>Everything that was checked, with the button that fixes what is missing.</summary>
	private void RefreshFacts()
	{
		_requirements = Pipeline.ReadRequirements(_target);
		_blockers = _requirements.Checks.Where(check => !check.Ok).ToList();

		Dependencies.Children.Clear();
		foreach (var check in _requirements.Checks)
		{
			Dependencies.Children.Add(Row(check));
		}

		// What is missing shows itself where it is fixed: on the fold's own label, in red and counted,
		// and the fold opens once so the line and its button are in front of the person.
		var missing = _blockers.Count;
		var header = new TextBlock
		{
			Text = missing > 0 ? $"Dependencies ({missing} missing)" : "Dependencies",
		};
		if (missing > 0)
		{
			header.Foreground = (Brush)Application.Current.Resources["SystemFillColorCriticalBrush"];
		}
		DependenciesExpander.Header = header;

		if (missing > 0 && !_missingSeen)
		{
			_missingSeen = true;
			DependenciesExpander.IsExpanded = true;
		}

		// A build that cannot work is not offered, and the reason is on the button that fixes it.
		BuildButton.IsEnabled = missing == 0;
	}

	private bool _missingSeen;

	private UIElement Row(Requirement check)
	{
		var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };

		line.Children.Add(new TextBlock
		{
			Text = check.Ok ? "\u2713" : "\u2717",
			Width = 18,
			VerticalAlignment = VerticalAlignment.Center,
			Foreground = (Brush)Application.Current.Resources[
				check.Ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"],
		});

		var label = new TextBlock
		{
			Text = check.Name,
			VerticalAlignment = VerticalAlignment.Center,
			MinWidth = 150,
		};
		if (!string.IsNullOrEmpty(check.Note))
		{
			ToolTipService.SetToolTip(label, check.Note);
		}
		line.Children.Add(label);

		line.Children.Add(new TextBlock
		{
			Text = check.Ok ? check.Found : check.Missing,
			VerticalAlignment = VerticalAlignment.Center,
			Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
			TextWrapping = TextWrapping.Wrap,
		});

		if (!check.Ok && (!string.IsNullOrEmpty(check.Install) || !string.IsNullOrEmpty(check.Url)))
		{
			var install = new Button
			{
				Content = string.IsNullOrEmpty(check.Install) ? "Get it" : "Install",
				VerticalAlignment = VerticalAlignment.Center,
			};
			var captured = check;
			install.Click += (_, _) => Pipeline.Install(captured);
			line.Children.Add(install);
		}

		return line;
	}

	/// <summary>
	/// The build's steps, in plain words: a tick for what is done, a dot and a sentence for what is
	/// happening now, a circle for what is left. Everything before the step it is on is done, whether
	/// it is still working or stopped there.
	/// </summary>
	private void ShowSteps(Progress? progress, bool running)
	{
		Steps.Children.Clear();
		var stages = progress?.Stages ?? Array.Empty<Step>();
		if (stages.Length == 0)
		{
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

			var row = new StackPanel { Spacing = 2 };
			var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
			line.Children.Add(new TextBlock { Text = mark, Width = 16, Foreground = brush });
			line.Children.Add(new TextBlock { Text = stage.Label, Foreground = brush, FontWeight = bold ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal });
			row.Children.Add(line);
			if (!string.IsNullOrEmpty(detail))
			{
				row.Children.Add(new TextBlock
				{
					Text = detail,
					Margin = new Thickness(24, 0, 0, 4),
					TextWrapping = TextWrapping.Wrap,
					Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
				});
			}
			else if (!string.IsNullOrEmpty(stage.Detail))
			{
				ToolTipService.SetToolTip(row, stage.Detail);
			}
			Steps.Children.Add(row);
		}
	}

	private readonly List<string> _notes = new();

	private void AppendLog(string line)
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

	private string? _buildLog;

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
		var built = Pipeline.EditorExists;
		var exit = Pipeline.LastExitCode(_target);
		var failed = !running && exit is not null && exit != "0";

		if (running)
		{
			BuildPanel.Visibility = Visibility.Visible;
			BuildButton.Visibility = Visibility.Collapsed;
			OpenButton.Visibility = Visibility.Collapsed;
			StopButton.Visibility = Visibility.Visible;

			_progress = Pipeline.ReadProgress(_target);
			if (_progress is not null)
			{
				Bar.Value = Math.Clamp(_progress.Percentage, 0, 100);
				Percent.Text = $"{Math.Round(_progress.Percentage)}%";
				Timing.Text = $"{Clock(_progress.ElapsedSeconds)} in" +
					(_progress.RemainingSeconds > 0 ? $", about {Clock(_progress.RemainingSeconds)} left" : "");
			}
			else
			{
				Percent.Text = "";
				Timing.Text = "starting...";
			}
			ShowSteps(_progress, true);
		}
		else
		{
			BuildButton.Visibility = Visibility.Visible;
			OpenButton.Visibility = Visibility.Visible;
			StopButton.Visibility = Visibility.Collapsed;
			OpenButton.IsEnabled = built;
			BuildButton.IsEnabled = _blockers.Count == 0 && (_target == BuildTarget.Windows || _linuxAvailable);

			_progress = Pipeline.ReadProgress(_target);
			if (_progress is not null)
			{
				BuildPanel.Visibility = Visibility.Visible;
				var value = _progress.Done == "ok" ? 100 : Math.Clamp(_progress.Percentage, 0, 100);
				Bar.Value = value;
				Percent.Text = $"{Math.Round(value)}%";
				Timing.Text = _progress.Done switch
				{
					"ok" => "the build finished, in PiCode-Win32-x64",
					"failed" => "the build stopped here. What it said is in the log below.",
					_ => $"{Clock(_progress.ElapsedSeconds)} in",
				};
				ShowSteps(_progress, false);
			}
		}

		_buildLog = Pipeline.ReadLog(_target);
		RenderLog();

		// Whatever a failed build said is the only thing worth reading then, so it is opened rather
		// than hinted at.
		if (failed && !_failedSeen)
		{
			_failedSeen = true;
			LogExpander.IsExpanded = true;
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
