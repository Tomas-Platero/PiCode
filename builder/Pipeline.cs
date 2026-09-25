using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace PiCode.Builder;

/// <summary>
/// The machine the build runs on.
///
/// The pipeline is the same either way — the same twelve scripts in `dev/`, in bash, and they already
/// speak both systems — so what changes between these two is only the door: on Windows bash is called
/// directly, and on Linux it is reached through WSL.
/// </summary>
public enum BuildTarget
{
	Windows,
	Linux,
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

	private static readonly Lazy<string> LazyRoot = new(FindRepoRoot);

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
				Found = true;
				return directory.FullName;
			}
			directory = directory.Parent;
		}

		// Not found: the executable was copied somewhere on its own. The window still opens, says so,
		// and offers nothing it cannot do - which is better than closing without a word, which is what
		// this did before, and what made a crash look like a problem with the theme.
		Found = false;
		return AppContext.BaseDirectory;
	}

	/// <summary>Whether the repository was found. A window that says "not here" beats one that vanishes.</summary>
	public static bool Found { get; private set; }

	public static string RepoRoot => LazyRoot.Value;

	public static string PackDirectory => Path.Combine(RepoRoot, "PiCode-Win32-x64");

	public static string EditorExecutable => Path.Combine(PackDirectory, "PiCode.exe");

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

	public static bool EditorExists => File.Exists(EditorExecutable);

	private static string LockFile => Path.Combine(RepoRoot, ".scratch", "build.lock");

	private static string StatusFile => Path.Combine(RepoRoot, ".scratch", "build.status");

	private static string LogFile => Path.Combine(RepoRoot, ".scratch", "build-live.log");

	/// <summary>
	/// The Linux path reaches the same directory from the other side. WSL mounts Windows drives under
	/// /mnt, so D:\repositorios\PiCode is /mnt/d/repositorios/PiCode.
	/// </summary>
	private static string LinuxRepoRoot()
	{
		var root = RepoRoot.Replace('\\', '/');
		if (root.Length > 1 && root[1] == ':')
		{
			return "/mnt/" + char.ToLowerInvariant(root[0]) + root[2..];
		}
		return root;
	}

	/// <summary>Whether there is a Linux to build in at all: WSL with a distribution, not just WSL.</summary>
	public static bool LinuxAvailable(out string reason)
	{
		var list = Run("wsl.exe", "-l -q", null, 20000);
		if (!list.Ok)
		{
			reason = "WSL is not installed, or is not ready. It needs a reboot after installing.";
			return false;
		}
		if (string.IsNullOrWhiteSpace(list.Output))
		{
			reason = "WSL has no distribution yet. Install one (wsl --install -d Ubuntu) and reboot.";
			return false;
		}
		reason = "";
		return true;
	}

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
		return target == BuildTarget.Windows
			? (BashPath.Value, "-c " + Quote(command))
			: ("wsl.exe", $"-d Ubuntu -- bash -lc {Quote(command)}");
	}

	private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

	/// <summary>The command and arguments that reach bash on the chosen side.</summary>
	private static (string Exe, string Args) Shell(BuildTarget target, string script)
	{
		return target == BuildTarget.Windows
			? (BashPath.Value, script)
			: ("wsl.exe", $"-d Ubuntu -- bash -lc \"cd {LinuxRepoRoot()} && {script}\"");
	}

	private static (string Exe, string Args) Node(BuildTarget target, string arguments)
	{
		return target == BuildTarget.Windows
			? ("node", arguments)
			: ("wsl.exe", $"-d Ubuntu -- bash -lc \"cd {LinuxRepoRoot()} && node {arguments}\"");
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
		var (exe, args) = Node(target, "dev/build-progress.mjs --json .scratch/build-live.log");
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
	public static bool StartBuild(BuildTarget target)
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
			process.Start();
			return true;
		}
		catch
		{
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
				var all = File.ReadAllLines(LogFile);
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
	/// deliberately not touched - deleting it means downloading and patching again, which is a different
	/// decision and one this should not make silently. Refuses while a build is running, because
	/// deleting the folder a build is writing into is how half of it disappears.
	/// </summary>
	public static (bool Ok, string Message) CleanBuild()
	{
		if (File.Exists(LockFile))
		{
			return (false, "A build is running. Stop it first.");
		}

		long removed = 0;
		try
		{
			if (Directory.Exists(PackDirectory))
			{
				removed += DirectorySize(PackDirectory);
				Directory.Delete(PackDirectory, true);
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

	/// <summary>
	/// Starts installing WSL and its distribution, in a terminal of its own: the installer asks
	/// questions and asks for a reboot, and those have to be seen to be answered.
	/// </summary>
	public static bool InstallWsl()
	{
		try
		{
			Process.Start(new ProcessStartInfo
			{
				FileName = "cmd.exe",
				Arguments = "/k wsl --install -d Ubuntu",
				UseShellExecute = true,
			});
			return true;
		}
		catch
		{
			return false;
		}
	}

	public static void OpenEditor()
	{
		if (!EditorExists)
		{
			return;
		}
		Process.Start(new ProcessStartInfo { FileName = EditorExecutable, UseShellExecute = true });
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
