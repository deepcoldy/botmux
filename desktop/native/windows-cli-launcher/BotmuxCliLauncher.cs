using System;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class BotmuxCliLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            string launcherDirectory = Path.GetDirectoryName(typeof(BotmuxCliLauncher).Assembly.Location);
            string resourcesDirectory = Directory.GetParent(launcherDirectory).FullName;
            string appDirectory = Directory.GetParent(resourcesDirectory).FullName;
            // executableName is botmux; productName Botmux may also appear as Botmux.exe
            string electronPath = Path.Combine(appDirectory, "botmux.exe");
            if (!File.Exists(electronPath))
            {
                electronPath = Path.Combine(appDirectory, "Botmux.exe");
            }
            string cliPath = Path.Combine(
                resourcesDirectory,
                "app.asar.unpacked",
                "out",
                "cli",
                "index.js"
            );

            if (!File.Exists(electronPath))
            {
                Console.Error.WriteLine("Unable to locate botmux.exe next to \"{0}\"", resourcesDirectory);
                return 1;
            }

            if (!File.Exists(cliPath))
            {
                Console.Error.WriteLine("Unable to locate the Botmux CLI entrypoint at \"{0}\"", cliPath);
                return 1;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = electronPath,
                Arguments = BuildArguments(cliPath, args),
                UseShellExecute = false
            };

            // Why: launching without cmd.exe preserves embedded newlines while matching the
            // packaged batch launcher's Electron-as-Node environment contract.
            MoveEnvironmentVariable(startInfo.EnvironmentVariables, "NODE_OPTIONS", "BOTMUX_NODE_OPTIONS");
            MoveEnvironmentVariable(
                startInfo.EnvironmentVariables,
                "NODE_REPL_EXTERNAL_MODULE",
                "BOTMUX_NODE_REPL_EXTERNAL_MODULE"
            );
            startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";

            using (Process child = Process.Start(startInfo))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the Botmux CLI: {0}", error.Message);
            return 1;
        }
    }

    private static void MoveEnvironmentVariable(
        StringDictionary environment,
        string sourceName,
        string targetName
    )
    {
        string value = Environment.GetEnvironmentVariable(sourceName);
        environment.Remove(sourceName);
        environment.Remove(targetName);
        if (value != null)
        {
            environment[targetName] = value;
        }
    }

    private static string BuildArguments(string cliPath, string[] args)
    {
        StringBuilder builder = new StringBuilder();
        builder.Append('"').Append(cliPath.Replace("\"", "\\\"")).Append('"');
        foreach (string arg in args)
        {
            builder.Append(' ');
            builder.Append('"').Append(arg.Replace("\"", "\\\"")).Append('"');
        }
        return builder.ToString();
    }
}
