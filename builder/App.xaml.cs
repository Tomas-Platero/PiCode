using System;
using System.IO;
using Microsoft.UI.Xaml;

namespace PiCode.Builder;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        // Before the interface is built, and that order is the point: WinUI reads the theme and the
        // accent while it builds its own resources, so setting them afterwards is too late at best and
        // a crash at worst.
        WriteCrashLog("starting");
        RequestedTheme = ApplicationTheme.Dark;
        WriteCrashLog("theme set");

        WriteCrashLog("accents come from App.xaml");
    }

    /// <summary>
    /// A crash inside the interface leaves no message anywhere a person can read, so the app writes its
    /// own: a window that closes in silence is a window nobody can debug.
    /// </summary>
    internal static void WriteCrashLog(string line)
    {
        try
        {
            var path = Path.Combine(Path.GetTempPath(), "picode-builder-crash.txt");
            File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
        }
        catch
        {
        }
    }


    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            WriteCrashLog("launching");
            _window = new MainWindow();
            WriteCrashLog("window built");
            _window.Activate();
            WriteCrashLog("window shown");
        }
        catch (Exception error)
        {
            WriteCrashLog("FAILED: " + error);
            throw;
        }
    }
}
