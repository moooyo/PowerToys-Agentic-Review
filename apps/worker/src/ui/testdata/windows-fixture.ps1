param(
    [Parameter(Mandatory = $true)][string]$Title,
    [switch]$DuplicateControl,
    [switch]$MixedControlTypes,
    [switch]$DuplicateButton,
    [switch]$DuplicateWindow,
    [switch]$ExitAfterClick,
    [switch]$NoWindow,
    [switch]$Descendant,
    [switch]$MetadataChildrenDuringReadiness,
    [switch]$SkipIdentity,
    [int]$TcpPort = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Forms;

public sealed class OwnedFixtureForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
public static class OwnedMetadataChildren {
    static readonly List<Process> children = new List<Process>();
    static readonly ManualResetEvent stop = new ManualResetEvent(false);
    static Thread worker;
    static Exception failure;
    public static void Start(string executable) {
        worker = new Thread(delegate() {
            try {
                for (int index = 0; index < 64 && !stop.WaitOne(75); index++) {
                    var start = new ProcessStartInfo(executable, "-NoLogo -NoProfile -NonInteractive -Command [System.Threading.Thread]::Sleep(20)");
                    start.UseShellExecute = false; start.CreateNoWindow = true;
                    var child = Process.Start(start);
                    if (child == null) throw new InvalidOperationException("The owned metadata child did not start.");
                    lock (children) children.Add(child);
                }
            } catch (Exception error) { failure = error; }
        });
        worker.IsBackground = true; worker.Start();
    }
    public static void Stop() {
        stop.Set();
        Exception cleanupFailure = worker != null && !worker.Join(5000)
            ? new InvalidOperationException("The metadata child launcher did not stop.") : null;
        var deadline = Stopwatch.StartNew();
        lock (children) {
            foreach (var child in children) {
                try { if (!child.HasExited) child.Kill(); }
                catch (Exception error) { if (!child.HasExited && cleanupFailure == null) cleanupFailure = error; }
            }
            foreach (var child in children) {
                try {
                    int remaining = Math.Max(1, 5000 - (int)deadline.ElapsedMilliseconds);
                    if (!child.WaitForExit(remaining) && cleanupFailure == null)
                        cleanupFailure = new InvalidOperationException("An owned metadata child did not exit.");
                } catch (Exception error) { if (cleanupFailure == null) cleanupFailure = error; }
                finally { child.Dispose(); }
            }
            children.Clear();
        }
        if (cleanupFailure != null) throw cleanupFailure;
        if (failure != null) throw new InvalidOperationException("The owned metadata child launcher failed.", failure);
    }
}
public static class WindowsUiFixture {
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    public static string Identity() {
        using (var process = Process.GetCurrentProcess()) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException();
            return "{\"pid\":" + process.Id + ",\"creationTimeFileTime\":\"" + created + "\"}";
        }
    }
    public static void Run(string title, bool duplicateControl, bool duplicateWindow, bool exitAfterClick, bool mixedControlTypes, bool duplicateButton) {
        Application.EnableVisualStyles();
        var form = new OwnedFixtureForm { Text = title, Name = "FixtureWindow", ClientSize = new Size(420, 210), StartPosition = FormStartPosition.Manual,
            Location = new Point(40, 40), ShowInTaskbar = false };
        var input = new TextBox { Name = "InputBox", AccessibleName = "Public input", Location = new Point(20, 20), Width = 240 };
        var save = new Button { Name = "SaveButton", AccessibleName = "Save", Text = "Save", Location = new Point(280, 18), Width = 90 };
        var result = new Label { Name = "ResultLabel", Text = "Waiting", Location = new Point(20, 70), Size = new Size(370, 25) };
        var password = new TextBox { Name = "SecretBox", AccessibleName = "Secret", UseSystemPasswordChar = true, Text = "fixture-secret", Location = new Point(20, 115), Width = 240 };
        var hang = new Button { Name = "HangButton", Text = "Hang fixture", Location = new Point(280, 113), Width = 90 };
        save.Click += delegate { if (exitAfterClick) Environment.Exit(0); result.Text = "Saved: " + input.Text; };
        hang.Click += delegate { System.Threading.Thread.Sleep(20000); };
        form.Controls.AddRange(new Control[] { input, save, result, password, hang });
        if (duplicateControl) form.Controls.Add(new Label { Name = "ResultLabel", Text = "Waiting", Location = new Point(20, 165), Size = new Size(370, 25) });
        if (mixedControlTypes) form.Controls.Add(new Label { Name = "SaveButton", AccessibleName = "Shared-ID text control", Text = "Shared-ID text control", Location = new Point(20, 165), Size = new Size(240, 25) });
        if (duplicateButton) {
            var otherSave = new Button { Name = "SaveButton", AccessibleName = "Other save", Text = "Other save", Location = new Point(280, 163), Width = 90 };
            otherSave.Click += delegate { result.Text = "Other button invoked"; };
            form.Controls.Add(otherSave);
        }
        Form second = null;
        if (duplicateWindow) second = new OwnedFixtureForm { Text = title, ClientSize = new Size(200, 80), ShowInTaskbar = false };
        var timer = new System.Windows.Forms.Timer { Interval = 45000 };
        timer.Tick += delegate { form.Close(); if (second != null) second.Close(); };
        form.Shown += delegate { if (second != null) second.Show(); timer.Start(); };
        Application.Run(form); timer.Dispose(); if (second != null) second.Dispose(); form.Dispose();
    }
}
'@
if (-not $SkipIdentity) {
    [Console]::Out.WriteLine([WindowsUiFixture]::Identity())
    [Console]::Out.Flush()
}
if ($TcpPort -gt 0) {
    $fixtureListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $TcpPort)
    try { $fixtureListener.Start(); Start-Sleep -Seconds 45 }
    finally { $fixtureListener.Stop() }
}
elseif ($NoWindow) {
    Start-Sleep -Seconds 45
}
elseif ($Descendant) {
    $fixtureStart = New-Object System.Diagnostics.ProcessStartInfo
    $fixtureStart.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $fixtureStart.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Title "' + $Title + '" -SkipIdentity'
    $fixtureStart.UseShellExecute = $false
    $fixtureStart.CreateNoWindow = $true
    $fixtureChild = $null
    try {
        if ($MetadataChildrenDuringReadiness) {
            [OwnedMetadataChildren]::Start($fixtureStart.FileName)
            Start-Sleep -Milliseconds 6500
        }
        $fixtureChild = [System.Diagnostics.Process]::Start($fixtureStart)
        $fixtureStop = [Console]::In.ReadLine()
        if ($fixtureStop -eq 'stop') { $null = $fixtureChild.CloseMainWindow() }
        if (-not $fixtureChild.WaitForExit(5000)) {
            $fixtureChild.Kill()
            if (-not $fixtureChild.WaitForExit(5000)) { throw 'The owned GUI child did not terminate.' }
        }
    }
    finally {
        try {
            if ($null -ne $fixtureChild) {
                try {
                    if (-not $fixtureChild.HasExited) {
                        $fixtureChild.Kill()
                        if (-not $fixtureChild.WaitForExit(5000)) { throw 'The owned GUI child did not terminate during cleanup.' }
                    }
                } finally { $fixtureChild.Dispose() }
            }
        } finally {
            if ($MetadataChildrenDuringReadiness) { [OwnedMetadataChildren]::Stop() }
        }
    }
}
else {
    [WindowsUiFixture]::Run($Title, $DuplicateControl.IsPresent, $DuplicateWindow.IsPresent, $ExitAfterClick.IsPresent, $MixedControlTypes.IsPresent, $DuplicateButton.IsPresent)
}
