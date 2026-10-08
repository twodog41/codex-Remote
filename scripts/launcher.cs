using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class RemoteCodexLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "scripts", "launch-wechat.ps1");
        bool complete = File.Exists(script) && File.Exists(Path.Combine(root, "runtime", "node.exe"))
            && File.Exists(Path.Combine(root, "node_modules", "qrcode-terminal", "package.json"));
        if (args.Length == 1 && args[0] == "--check") return complete ? 0 : 1;
        if (!complete)
        {
            MessageBox.Show("请下载并完整解压 Windows 便携包，再运行 RemoteCodex.exe。单独的 exe 不包含运行环境和程序文件。", "Remote Codex");
            return 1;
        }
        try
        {
            Process.Start(new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NoExit -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = true
            });
            return 0;
        }
        catch (Exception error) { MessageBox.Show(error.Message, "Remote Codex 启动失败"); return 1; }
    }
}
