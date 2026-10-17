#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace PiCode.Builder;

/// <summary>
/// The machine the build runs on. There is one: Windows, `win-x64`. The pipeline in `dev/` is the same
/// twelve bash scripts whether it is driven from here or from a terminal; this only names the door.
/// </summary>
public enum BuildTarget
{
	Windows,
}

/// <summary>One check of what the build needs, as `dev/build-requirements.mjs` reports it.</summary>
public sealed class Requirement
{
	public string Id { get; set; } = "";
	public string Icon { get; set; } = "";
	public bool Optional { get; set; }
	public string Name { get; set; } = "";
	public bool Ok { get; set; }
	public string Found { get; set; } = "";
	public string Missing { get; set; } = "";
	public string Install { get; set; } = "";
	public string Url { get; set; } = "";
	public string Note { get; set; } = "";
}

public sealed class Requirements
{
	public string Platform { get; set; } = "";
	public bool Ready { get; set; }
	public int Required { get; set; }
	public string[] Blockers { get; set; } = Array.Empty<string>();
	public Requirement[] Checks { get; set; } = Array.Empty<Requirement>();

	public int Missing => Checks.Count(check => !check.Ok);
}

/// <summary>One step of the build, in the words the module writes for a person.</summary>
public sealed class Step
{
	public string Label { get; set; } = "";
	public string Detail { get; set; } = "";
}

/// <summary>Where the build is, as `dev/build-progress.mjs` reports it.</summary>
public sealed class Progress
{
	public double Percentage { get; set; }
	public string Stage { get; set; } = "";
	public string StageDetail { get; set; } = "";
	public int StageIndex { get; set; }
	public Step[] Stages { get; set; } = Array.Empty<Step>();
	public int ElapsedSeconds { get; set; }
	public int RemainingSeconds { get; set; }
	public string? Done { get; set; }
	public string LastLine { get; set; } = "";
}

/// <summary>
/// Everything outside this window, in one place: what the build needs, how it is started, how far it
/// has got, and what it said.
///
/// Nothing here reimplements the pipeline. The scripts are the build; this asks them questions and
/// reads their answers, which is the same contract the PowerShell window has and the reason the two
/// can coexist while this one is finished.
/// </summary>
public sealed class Pipeline
{
	private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

	private static string? _root;

	private static string FindRepoRoot()
	{
		// Where the executable really is. `AppContext.BaseDirectory` is not that in a single-file
		// publish: it is the temporary folder the runtime unpacks itself into, so the search below
		// started in %TEMP% and never found anything. That one mistake showed up as four things - a
		// strange path in the footer, no checks, a button that did nothing, and no icon.
		var start = Environment.ProcessPath is { Length: > 0 } processPath
			? Path.GetDirectoryName(processPath) ?? AppContext.BaseDirectory
			: AppContext.BaseDirectory;

		// Walking up to the folder that holds the pipeline is steadier than counting levels, and it
		// keeps working if the app is ever moved.
		var directory = new DirectoryInfo(start);
		while (directory is not null)
		{
			if (File.Exists(Path.Combine(directory.FullName, "dev", "build.sh")))
			{
				return directory.FullName;
			}
			directory = directory.Parent;
		}

		// Not found: the executable was copied somewhere on its own. The window still opens, says so,
		// and offers nothing it cannot do - which is better than closing without a word, which is what
		// this did before, and what made a crash look like a problem with the theme.
		return AppContext.BaseDirectory;
	}

	/// <summary>
	/// Whether the repository was found. A window that says "not here" beats one that vanishes. It is
	/// asked of the tree rather than remembered, so pointing the window at a folder - a fresh download,
	/// say - makes every part of it tell the truth again.
	/// </summary>
	public static bool Found => File.Exists(Path.Combine(RepoRoot, "dev", "build.sh"));

	public static string RepoRoot => _root ??= FindRepoRoot();

	/// <summary>
	/// Points the window at a tree. It is how the source is adopted after a download or a folder is
	/// picked: from here the same window reads the checks, the branch and the version of the new tree,
	/// with no restart and no second copy of the program.
	/// </summary>
	public static bool UseRoot(string path)
	{
		if (string.IsNullOrWhiteSpace(path) || !File.Exists(Path.Combine(path, "dev", "build.sh")))
		{
			return false;
		}
		_root = path;
		return true;
	}

	/// <summary>
	/// The branch the repository is on, as git answers it. The channel the build seals comes from
	/// this: one channel per branch is the owner's rule (2026-10-08), so building from `beta` has
	/// to produce the beta product and building from `experimental` the experimental one — the
	/// same relation the release workflow reads from the tag.
	///
	/// Read once and kept: the label that shows it is repainted every second, and asking git on each
	/// of those seconds was a process spawned where an answer would do. Picking a different tree
	/// throws the answer away, because that is the one thing that makes it wrong.
	/// </summary>
	private static string? _branch;
	private static bool _branchRead;
	private static string? _branchOf;

	public static string? CurrentBranch
	{
		get
		{
			if (!Found)
			{
				return null;
			}
			var root = RepoRoot;
			if (_branchRead && _branchOf == root)
			{
				return _branch;
			}
			var result = Run("git", "rev-parse --abbrev-ref HEAD", root, 15000);
			var line = result.Ok ? result.Output.Trim() : "";
			_branch = line.Length > 0 && line != "HEAD" ? line : null;
			_branchRead = true;
			_branchOf = root;
			return _branch;
		}
	}

	/// <summary>
	/// The channel the build will seal, derived from the branch. `master` builds stable, `beta`
	/// builds beta and `experimental` builds experimental; any other branch (a feature one, for
	/// example) seals nothing, and the pipeline keeps its own plain behaviour — which installs
	/// as the stable product without asking a channel feed. Returning the name rather than a
	/// value keeps the one mapping the release workflow also carries, and an unknown branch is
	/// a fact to show, not an error to stop on.
	/// </summary>
	public static (string? Channel, string Branch) ChannelForBranch()
	{
		var branch = CurrentBranch;
		var channel = branch switch
		{
			"master" => "stable",
			"beta" => "beta",
			"experimental" => "experimental",
			_ => (string?)null,
		};
		return (channel, branch ?? "");
	}

	/// <summary>
	/// The channel a person picked in the window, or null for "follow the branch". The branch is the
	/// owner's rule and stays the default, but a builder carried out of the repository has no branch to
	/// read - a download has no history to speak of - and then the only honest answer is to be asked.
	/// </summary>
	public static string? ChannelSelection { get; set; }

	/// <summary>What the build will really seal: the picked channel, or the branch's own.</summary>
	public static string? Channel => ChannelSelection ?? ChannelForBranch().Channel;

	/// <summary>
	/// The product version the delta carries, as `dev/build.sh` reads it. Shown, not decided.
	/// </summary>
	public static string ProductVersion
	{
		get
		{
			try
			{
				using var document = System.Text.Json.JsonDocument.Parse(
					File.ReadAllText(Path.Combine(RepoRoot, "distribution", "product-delta.json")));
				return document.RootElement.GetProperty("set").GetProperty("picodeVersion").GetString() ?? "";
			}
			catch
			{
				return "";
			}
		}
	}

	public static string PackDirectory(BuildTarget target)
	{
		var suffix = Channel switch
		{
			"beta" => "-beta",
			"experimental" => "-experimental",
			_ => "",
		};
		return Path.Combine(RepoRoot, $"PiCode-Win32-x64{suffix}");
	}

	public static string EditorExecutable(BuildTarget target)
	{
		// The editor's file carries the channel in its name: stable is `PiCode.exe`, beta
		// `PiCode Beta.exe` and experimental `PiCode Experimental.exe`. The seal sets `nameShort`
		// to exactly that and the packer names the executable from it, so the window has to ask for
		// the same name it produced - asking for `PiCode.exe` under a channel found nothing, which
		// showed up as a build that "never produced an editor".
		var label = Channel switch
		{
			"beta" => " Beta",
			"experimental" => " Experimental",
			_ => "",
		};
		return Path.Combine(PackDirectory(target), $"PiCode{label}.exe");
	}

	public static bool EditorExists(BuildTarget target) => File.Exists(EditorExecutable(target));

	/// <summary>
	/// Downloads the PiCode source into a folder the person chooses, so a builder copied out of the
	/// repository on its own can still get to a build. Without the source there is nothing to build,
	/// and saying that is not enough - this is the way back.
	/// </summary>
	public static (bool Ok, string Message) CloneSource(string targetDir)
	{
		if (string.IsNullOrWhiteSpace(targetDir))
		{
			return (false, "No folder chosen.");
		}
		if (Directory.Exists(Path.Combine(targetDir, "dev", "build.sh")))
		{
			return (true, "The source is already there.");
		}
		if (Directory.Exists(targetDir) && Directory.EnumerateFileSystemEntries(targetDir).Any())
		{
			return (false, "The chosen folder is not empty. Pick an empty or new folder.");
		}
		try
		{
			Directory.CreateDirectory(targetDir);
		}
		catch (Exception error)
		{
			return (false, "Could not create the folder: " + error.Message);
		}
		var (exe, args) = (BashPath.Value, "-c " + Quote($"git clone https://github.com/Tomas-Platero/PiCode.git {Quote(targetDir)}"));
		// Fall back to git directly if bash is missing.
		if (!File.Exists(BashPath.Value) || BashPath.Value == "bash")
		{
			(exe, args) = ("git", $"clone https://github.com/Tomas-Platero/PiCode.git \"{targetDir}\"");
		}
		var result = Run(exe, args, null, 600000);
		if (!result.Ok)
		{
			try { Directory.Delete(targetDir, true); } catch { }
			return (false, "Clone failed: " + (string.IsNullOrWhiteSpace(result.Errors) ? result.Output : result.Errors));
		}
		return (true, "Source downloaded. Restart the builder from inside the new folder.");
	}

	/// <summary>
	/// The brand marks, in the folder beside this program. Where one is missing the window falls back to
	/// the plain mark, which is why a clone without them still shows every check.
	/// </summary>
	public static string? BrandIcon(string name)
	{
		if (string.IsNullOrEmpty(name))
		{
			return null;
		}
		var path = name == "picode"
			? Path.Combine(RepoRoot, "distribution", "picode-icon.svg")
			: Path.Combine(RepoRoot, "builder", "Assets", "brands", name + ".svg");
		return File.Exists(path) ? path : null;
	}

	private static string LockFile => Path.Combine(RepoRoot, ".scratch", "build.lock");

	private static string StatusFile => Path.Combine(RepoRoot, ".scratch", "build.status");

	private static string LogFile => Path.Combine(RepoRoot, ".scratch", "build-live.log");

	/// <summary>
	/// Which bash, found once. Asking the PATH is how a running build went unseen: from a terminal the
	/// PATH resolves `bash` to Git's, but a program opened from Explorer can resolve it to the WSL
	/// stub in System32, which cannot run Git Bash scripts - and every question asked through it came
	/// back empty, so the window believed nothing was running over a build that was.
	/// </summary>
	private static readonly Lazy<string> BashPath = new(() =>
	{
		var candidates = new[]
		{
			Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "bin", "bash.exe"),
			Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "usr", "bin", "bash.exe"),
			Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Git", "bin", "bash.exe"),
		};
		foreach (var candidate in candidates)
		{
			if (File.Exists(candidate))
			{
				return candidate;
			}
		}
		return "bash";
	});

	public static string BashDescription => BashPath.Value;

	/// <summary>
	/// A bash *command* - a string for bash to run, not a script file. This is the call that was broken:
	/// without -c, bash reads the command as a file name, answers nothing, and the caller believes
	/// whatever absence means.
	/// </summary>
	private static (string Exe, string Args) BashCommand(BuildTarget target, string command)
	{
		return (BashPath.Value, "-c " + Quote(command));
	}

	private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

	/// <summary>The command and arguments that reach bash on the chosen side.</summary>
	private static (string Exe, string Args) Shell(BuildTarget target, string script)
	{
		return (BashPath.Value, script);
	}

	private static (string Exe, string Args) Node(BuildTarget target, string arguments)
	{
		return ("node", arguments);
	}

	public sealed record CommandResult(bool Ok, string Output, string Errors, int ExitCode);

	/// <summary>Runs something and waits, with a ceiling: a build question must never hang the window.</summary>
	public static CommandResult Run(string exe, string args, string? workingDirectory, int timeoutMs)
	{
		try
		{
			using var process = new Process
			{
				StartInfo = new ProcessStartInfo
				{
					FileName = exe,
					Arguments = args,
					WorkingDirectory = workingDirectory ?? RepoRoot,
					RedirectStandardOutput = true,
					RedirectStandardError = true,
					UseShellExecute = false,
					CreateNoWindow = true,
					StandardOutputEncoding = Encoding.UTF8,
				},
			};
			var output = new StringBuilder();
			var errors = new StringBuilder();
			process.OutputDataReceived += (_, e) => { if (e.Data is not null) { output.AppendLine(e.Data); } };
			process.ErrorDataReceived += (_, e) => { if (e.Data is not null) { errors.AppendLine(e.Data); } };
			process.Start();
			process.BeginOutputReadLine();
			process.BeginErrorReadLine();
			if (!process.WaitForExit(timeoutMs))
			{
				try { process.Kill(true); } catch { }
				return new CommandResult(false, output.ToString(), "timed out", -1);
			}
			process.WaitForExit();
			return new CommandResult(process.ExitCode == 0, output.ToString(), errors.ToString(), process.ExitCode);
		}
		catch (Exception error)
		{
			return new CommandResult(false, "", error.Message, -1);
		}
	}

	public static Requirements ReadRequirements(BuildTarget target)
	{
		var (exe, args) = Node(target, "dev/build-requirements.mjs --json");
		var result = Run(exe, args, RepoRoot, 60000);
		if (!result.Ok || string.IsNullOrWhiteSpace(result.Output))
		{
			return new Requirements();
		}
		try
		{
			return JsonSerializer.Deserialize<Requirements>(result.Output, Json) ?? new Requirements();
		}
		catch (JsonException)
		{
			return new Requirements();
		}
	}

	public static Progress? ReadProgress(BuildTarget target)
	{
		// The newest evidence wins: a build started by hand through dev/build.sh writes no live log, so
		// pinning this argument meant command-line builds were invisible to the window. With no argument
		// the module picks the newest log it finds; the runner's verdict file is read on top of that.
		var arguments = File.Exists(LogFile)
			? "dev/build-progress.mjs --json .scratch/build-live.log"
			: "dev/build-progress.mjs --json";
		var (exe, args) = Node(target, arguments);
		var result = Run(exe, args, RepoRoot, 30000);
		if (!result.Ok || string.IsNullOrWhiteSpace(result.Output))
		{
			return null;
		}
		try
		{
			return JsonSerializer.Deserialize<Progress>(result.Output, Json);
		}
		catch (JsonException)
		{
			return null;
		}
	}

	/// <summary>The process id the runner wrote when it started, or nothing when no build is running.</summary>
	private static string? LockedProcess()
	{
		try
		{
			if (!File.Exists(LockFile))
			{
				return null;
			}
			foreach (var line in File.ReadAllLines(LockFile))
			{
				var trimmed = line.Trim();
				if (trimmed.Length > 0 && trimmed.All(char.IsDigit))
				{
					return trimmed;
				}
			}
			return null;
		}
		catch (IOException)
		{
			return null;
		}
	}

	/// <summary>
	/// Whether the build is alive. bash answers, because the id in the lock is bash's own and Windows'
	/// process list has never held it: asking Windows is what once made a window call a running build
	/// dead. `kill -0` is the same test the runner trusts.
	/// </summary>
	public static bool IsBuildRunning(BuildTarget target)
	{
		var id = LockedProcess();
		if (id is null)
		{
			return false;
		}
		var (exe, args) = BashCommand(target, $"kill -0 {id} 2>/dev/null && echo alive || echo gone");
		var result = Run(exe, args, RepoRoot, 20000);
		return result.Output.Contains("alive", StringComparison.Ordinal);
	}

	public static void ClearStaleLock()
	{
		try { File.Delete(LockFile); } catch (IOException) { }
	}

	/// <summary>
	/// Starts the build and returns at once. The runner keeps the lock, the log and the exit code, so
	/// the window only has to watch those files: it does not own the build, and closing it does not
	/// stop one.
	/// </summary>
	public static bool StartBuild(BuildTarget target, Dictionary<string, string>? extraEnv = null)
	{
		try
		{
			var (exe, args) = Shell(target, "dev/build-run.sh");
			using var process = new Process
			{
				StartInfo = new ProcessStartInfo
				{
					FileName = exe,
					Arguments = args,
					WorkingDirectory = RepoRoot,
					UseShellExecute = false,
					CreateNoWindow = true,
				},
			};
			// The channel is not a flag of the scripts: it arrives as an environment variable,
			// the same door the release workflow uses. It is the channel picked in the window, or
			// the branch's own when the window leaves it on "auto"; with no channel nothing is
			// passed, and the build keeps its own plain behaviour.
			if (Channel is { } channel)
			{
				process.StartInfo.EnvironmentVariables["PICODE_CHANNEL"] = channel;
			}
			// The window's own switches (installer, incremental, CLI) come in pairs and are applied
			// after the channel, so a blunt pair always wins over the going concern above.
			if (extraEnv is not null)
			{
				foreach (var (key, value) in extraEnv)
				{
					process.StartInfo.EnvironmentVariables[key] = value;
				}
			}
			process.Start();
			return true;
		}
		catch (Exception error)
		{
			// A start that fails in silence is a button that appears to do nothing, which is exactly
			// what the owner saw once. Say it where the window's own log can show it.
			try
			{
				App.WriteCrashLog("StartBuild failed: " + error.Message);
			}
			catch { }
			return false;
		}
	}

	public static bool StopBuild(BuildTarget target)
	{
		var id = LockedProcess();
		if (id is null)
		{
			ClearStaleLock();
			return false;
		}
		var (exe, args) = BashCommand(target, $"kill -TERM {id} 2>/dev/null; true");
		Run(exe, args, RepoRoot, 20000);
		return true;
	}

	/// <summary>The last thing the build said, for the log under everything else.</summary>
	public static string ReadLog(BuildTarget target, int lines = 300)
	{
		if (target == BuildTarget.Windows)
		{
			try
			{
				if (!File.Exists(LogFile))
				{
					return "";
				}
				// Read with sharing so a log being actively written by the build is not locked out.
				using var stream = new FileStream(LogFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
				using var reader = new StreamReader(stream);
				var all = reader.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
				return string.Join(Environment.NewLine, all.TakeLast(lines));
			}
			catch (IOException)
			{
				return "";
			}
		}
		var (exe, args) = Shell(target, $"tail -n {lines} .scratch/build-live.log 2>/dev/null");
		return Run(exe, args, RepoRoot, 30000).Output;
	}

	/// <summary>The runner's verdict on the last build: 0 means it finished, anything else did not.</summary>
	public static string? LastExitCode(BuildTarget target)
	{
		try
		{
			if (!File.Exists(StatusFile))
			{
				return null;
			}
			return File.ReadAllText(StatusFile).Trim();
		}
		catch (IOException)
		{
			return null;
		}
	}

	/// <summary>
	/// Removes what a build left behind: the packed editor and the runner's verdict. The source tree is
	/// deliberately not touched - deleting it means compiling again, which is a different decision and
	/// one this should not make silently. Refuses while a build is running, because deleting the folder
	/// a build is writing into is how half of it disappears.
	/// </summary>
	public static (bool Ok, string Message) CleanBuild(BuildTarget target)
	{
		if (File.Exists(LockFile))
		{
			return (false, "A build is running. Stop it first.");
		}

		long removed = 0;
		try
		{
			var packDir = PackDirectory(target);
			if (Directory.Exists(packDir))
			{
				removed += DirectorySize(packDir);
				Directory.Delete(packDir, true);
			}
			foreach (var file in new[] { StatusFile, LogFile })
			{
				if (File.Exists(file))
				{
					removed += new FileInfo(file).Length;
					File.Delete(file);
				}
			}
		}
		catch (Exception error) when (error is IOException or UnauthorizedAccessException)
		{
			// The usual cause is the editor running from the folder being deleted.
			return (false, "Could not remove everything - is PiCode running? " + error.Message);
		}

		var megabytes = Math.Round(removed / (1024.0 * 1024.0));
		return (true, megabytes > 0 ? $"Removed {megabytes} MB." : "There was nothing to remove.");
	}

	private static long DirectorySize(string directory)
	{
		long total = 0;
		try
		{
			foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
			{
				try { total += new FileInfo(file).Length; } catch (IOException) { }
			}
		}
		catch (IOException)
		{
		}
		return total;
	}

	public static void OpenEditor(BuildTarget target)
	{
		if (!EditorExists(target))
		{
			return;
		}
		Process.Start(new ProcessStartInfo { FileName = EditorExecutable(target), UseShellExecute = true });
	}

	/// <summary>
	/// Offers a missing piece. With winget it opens a terminal, so its own questions and its own
	/// progress are seen; without winget there is nothing to run, so the download page opens.
	/// </summary>
	public static void Install(Requirement requirement)
	{
		if (!string.IsNullOrEmpty(requirement.Install) && Run("winget", "--version", null, 15000).Ok)
		{
			Process.Start(new ProcessStartInfo
			{
				FileName = "cmd.exe",
				Arguments = $"/k winget install --id {requirement.Install} -e --accept-source-agreements --accept-package-agreements",
				UseShellExecute = true,
			});
			return;
		}
		if (!string.IsNullOrEmpty(requirement.Url))
		{
			Process.Start(new ProcessStartInfo { FileName = requirement.Url, UseShellExecute = true });
		}
	}
}
