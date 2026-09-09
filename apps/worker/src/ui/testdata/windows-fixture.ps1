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
    [switch]$HelperExitAfterClick,
    [switch]$TracePublicInput,
    [switch]$BackgroundBeforeClick,
    [switch]$OccludeClick,
    [switch]$AncestorExitAfterClick,
    [switch]$AwaitParentReady,
    [int]$ExitParentPid = 0,
    [string]$ExitParentCreationTime = '',
    [switch]$ReportTcpReady,
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
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    public static string Identity() {
        using (var process = Process.GetCurrentProcess()) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException();
            return "{\"pid\":" + process.Id + ",\"creationTimeFileTime\":\"" + created + "\"}";
        }
    }
    public static Process HoldIdentity(int processId, string expectedCreated) {
        var process = Process.GetProcessById(processId);
        try {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user)
                || created.ToString(System.Globalization.CultureInfo.InvariantCulture) != expectedCreated || process.HasExited)
                throw new InvalidOperationException("The owned fixture process identity changed.");
            return process;
        } catch { process.Dispose(); throw; }
    }
    public static string ReadHandshake(System.IO.TextReader reader) {
        // Console.In can implement ReadLineAsync synchronously, so bound a separate reader task.
        var read = System.Threading.Tasks.Task<string>.Factory.StartNew(delegate { return reader.ReadLine(); });
        if (!read.Wait(15000)) throw new InvalidOperationException("The owned descendant handshake exceeded its deadline.");
        if (read.Result == null) throw new InvalidOperationException("The owned descendant exited before its handshake.");
        return read.Result;
    }
    public static void Run(string title, bool duplicateControl, bool duplicateWindow, bool exitAfterClick, bool mixedControlTypes, bool duplicateButton,
        string helperExecutable, Process exitParent, bool tracePublicInput, bool backgroundBeforeClick, bool occludeClick) {
        Process helper = null;
        bool helperExited = false;
        if (!String.IsNullOrEmpty(helperExecutable)) {
            var start = new ProcessStartInfo(helperExecutable, "-NoLogo -NoProfile -NonInteractive -Command [System.Threading.Thread]::Sleep(45000)");
            start.UseShellExecute = false; start.CreateNoWindow = true;
            helper = Process.Start(start);
            if (helper == null) throw new InvalidOperationException("The owned click helper did not start.");
        }
        try {
        Application.EnableVisualStyles();
        var form = new OwnedFixtureForm { Text = title, Name = "FixtureWindow", ClientSize = new Size(420, 210), StartPosition = FormStartPosition.Manual,
            Location = new Point(40, 40), ShowInTaskbar = false };
        var input = new TextBox { Name = "InputBox", AccessibleName = "Public input", Location = new Point(20, 20), Width = 240 };
        var save = new Button { Name = "SaveButton", AccessibleName = "Save", Text = "Save", Location = new Point(280, 18), Width = 90 };
        var result = new Label { Name = "ResultLabel", Text = "Waiting", Location = new Point(20, 70), Size = new Size(370, 25) };
        var password = new TextBox { Name = "SecretBox", AccessibleName = "Secret", UseSystemPasswordChar = true, Text = "fixture-secret", Location = new Point(20, 115), Width = 240 };
        var hang = new Button { Name = "HangButton", Text = "Hang fixture", Location = new Point(280, 113), Width = 90 };
        int clickCount = 0;
        int backgroundClickCount = 0;
        bool backgroundPrepared = false;
        bool targetForegroundWitness = false;
        Form neutral = null;
        bool runningWindowLoop = true;
        if (backgroundBeforeClick) {
            result.Text = "Clicks: 0; foreground: none; background clicks: 0";
            var preparation = new Label { Name = "ForegroundPreparationLabel", Text = "Preparing background window", Location = new Point(20, 165), Size = new Size(370, 25) };
            form.Controls.Add(preparation);
            neutral = new OwnedFixtureForm { Text = title + " neutral", Name = "NeutralWindow", ClientSize = new Size(200, 80),
                StartPosition = FormStartPosition.Manual, Location = new Point(500, 40), ShowInTaskbar = false, TopMost = occludeClick,
                FormBorderStyle = occludeClick ? FormBorderStyle.None : FormBorderStyle.Sizable };
            var prepareButton = new Button { Name = "NeutralPrepareButton", Text = "Prepare background", Dock = DockStyle.Fill };
            prepareButton.Click += delegate {
                // A verified UIA action prepares foreground explicitly; Activate alone can be denied.
                IntPtr foreground = GetForegroundWindow();
                bool prepared = foreground == neutral.Handle && foreground != form.Handle && clickCount == 0;
                backgroundPrepared = prepared;
                targetForegroundWitness = false;
                preparation.Text = prepared ? "Before click: background; clicks: 0" : "Background setup failed";
                prepareButton.Text = prepared ? "Background prepared" : "Background setup failed";
            };
            form.Activated += delegate {
                if (backgroundPrepared && clickCount == 0 && GetForegroundWindow() == form.Handle) {
                    targetForegroundWitness = true;
                    preparation.Text = "Target foreground witnessed before click";
                }
            };
            neutral.Controls.Add(prepareButton);
            // Closing either top-level fixture window must end the owned GUI process.
            neutral.FormClosed += delegate { if (runningWindowLoop && !form.IsDisposed) form.Close(); };
            form.Shown += delegate {
                // A separate top-level root stays above the target when occlusion is requested.
                if (occludeClick) {
                    var bounds = save.RectangleToScreen(save.ClientRectangle);
                    bounds.Inflate(10, 10);
                    neutral.Bounds = bounds;
                }
                neutral.Show();
            };
        }
        if (tracePublicInput) {
            int eventCount = 0;
            Action<string> trace = delegate(string kind) {
                if (eventCount++ >= 64) return;
                Console.Error.WriteLine("{\"type\":\"fixture_input\",\"event\":\"" + kind + "\",\"length\":" + input.Text.Length + "}");
                Console.Error.Flush();
            };
            input.TextChanged += delegate { trace("text_changed"); };
            input.KeyPress += delegate { trace("key_press"); };
            form.Activated += delegate { trace("window_activated"); };
        }
        save.Click += delegate {
            if (backgroundBeforeClick) {
                bool foreground = GetForegroundWindow() == form.Handle;
                clickCount++;
                if (!foreground) backgroundClickCount++;
                // Invoke can dispatch the callback later; retain that later sample separately.
                result.Text = "Clicks: " + clickCount + "; foreground witnessed: " + targetForegroundWitness.ToString().ToLowerInvariant()
                    + "; callback foreground: " + foreground.ToString().ToLowerInvariant()
                    + "; background clicks: " + backgroundClickCount;
                return;
            }
            if (exitAfterClick) Environment.Exit(0);
            if (helper != null && !helperExited) {
                if (helper.HasExited) throw new InvalidOperationException("The owned click helper exited before the click.");
                helper.Kill();
                if (!helper.WaitForExit(5000)) throw new InvalidOperationException("The owned click helper did not exit after the click.");
                helperExited = true;
            }
            if (exitParent != null) {
                if (exitParent.HasExited) throw new InvalidOperationException("The owned ancestor exited before the click.");
                exitParent.Kill();
                if (!exitParent.WaitForExit(5000)) throw new InvalidOperationException("The owned ancestor did not exit after the click.");
                result.Text = "Ancestor exited";
                return;
            }
            result.Text = "Saved: " + input.Text;
        };
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
        try { Application.Run(form); }
        finally {
            runningWindowLoop = false;
            timer.Dispose();
            if (neutral != null) neutral.Dispose();
            if (second != null) second.Dispose();
            form.Dispose();
        }
        } finally {
            if (helper != null) {
                try {
                    if (!helper.HasExited) helper.Kill();
                    if (!helper.WaitForExit(5000)) throw new InvalidOperationException("The owned click helper did not exit during cleanup.");
                } finally { helper.Dispose(); }
            }
            if (exitParent != null) exitParent.Dispose();
        }
    }
}
'@

function Read-FixtureLine([System.IO.TextReader]$Reader) {
    return [WindowsUiFixture]::ReadHandshake($Reader)
}

function Stop-FixtureProcess([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            $null = $Process.CloseMainWindow()
            if (-not $Process.WaitForExit(5000)) { $Process.Kill() }
        }
        if (-not $Process.WaitForExit(5000)) { throw 'The owned fixture process did not terminate during cleanup.' }
    } finally { $Process.Dispose() }
}

if (-not $SkipIdentity -and -not ($Descendant -and $TcpPort -gt 0)) {
    [Console]::Out.WriteLine([WindowsUiFixture]::Identity())
    [Console]::Out.Flush()
}
if ($TcpPort -gt 0 -and -not $Descendant) {
    $fixtureListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $TcpPort)
    try {
        $fixtureListener.Start()
        if ($ReportTcpReady) {
            [Console]::Out.WriteLine('listener_ready')
            [Console]::Out.Flush()
        }
        Start-Sleep -Seconds 45
    }
    finally { $fixtureListener.Stop() }
}
elseif ($NoWindow) {
    Start-Sleep -Seconds 45
}
elseif ($AncestorExitAfterClick -and -not $Descendant) {
    $fixtureStart = New-Object System.Diagnostics.ProcessStartInfo
    $fixtureStart.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $fixtureStart.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Title "' + $Title + '" -SkipIdentity -Descendant -AncestorExitAfterClick'
    $fixtureStart.UseShellExecute = $false
    $fixtureStart.CreateNoWindow = $true
    $fixtureStart.RedirectStandardInput = $true
    $fixtureStart.RedirectStandardOutput = $true
    $fixtureAncestor = $null
    $fixtureGui = $null
    try {
        $fixtureAncestor = [System.Diagnostics.Process]::Start($fixtureStart)
        $fixtureGuiIdentity = (Read-FixtureLine $fixtureAncestor.StandardOutput) | ConvertFrom-Json
        $fixtureGui = [WindowsUiFixture]::HoldIdentity($fixtureGuiIdentity.pid, $fixtureGuiIdentity.creationTimeFileTime)
        $fixtureAncestor.StandardInput.WriteLine('ready')
        $fixtureAncestor.StandardInput.Flush()
        while ($true) {
            $fixtureCommand = [Console]::In.ReadLine()
            if ($fixtureCommand -eq 'status') {
                [Console]::Out.WriteLine('{"event":"fixture_status","guiAlive":' + (-not $fixtureGui.HasExited).ToString().ToLowerInvariant() + ',"ancestorAlive":' + (-not $fixtureAncestor.HasExited).ToString().ToLowerInvariant() + '}')
                [Console]::Out.Flush()
            }
            elseif ($fixtureCommand -eq 'stop' -or $null -eq $fixtureCommand) { break }
            else { throw 'The owned fixture received an unknown command.' }
        }
    }
    finally {
        try { Stop-FixtureProcess $fixtureGui }
        finally { Stop-FixtureProcess $fixtureAncestor }
    }
}
elseif ($Descendant) {
    $fixtureStart = New-Object System.Diagnostics.ProcessStartInfo
    $fixtureStart.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $fixtureStart.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Title "' + $Title + '" -SkipIdentity'
    if ($ExitAfterClick) { $fixtureStart.Arguments += ' -ExitAfterClick' }
    if ($HelperExitAfterClick) { $fixtureStart.Arguments += ' -HelperExitAfterClick' }
    if ($TracePublicInput) { $fixtureStart.Arguments += ' -TracePublicInput' }
    if ($BackgroundBeforeClick) { $fixtureStart.Arguments += ' -BackgroundBeforeClick' }
    if ($OccludeClick) { $fixtureStart.Arguments += ' -OccludeClick' }
    if ($TcpPort -gt 0) {
        $fixtureStart.Arguments += ' -TcpPort ' + $TcpPort + ' -ReportTcpReady'
        $fixtureStart.RedirectStandardOutput = $true
    }
    if ($AncestorExitAfterClick) {
        $fixtureOwnIdentity = [WindowsUiFixture]::Identity() | ConvertFrom-Json
        $fixtureStart.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Title "' + $Title + '" -AwaitParentReady -ExitParentPid ' + $PID + ' -ExitParentCreationTime ' + $fixtureOwnIdentity.creationTimeFileTime
        $fixtureStart.RedirectStandardInput = $true
        $fixtureStart.RedirectStandardOutput = $true
    }
    $fixtureStart.UseShellExecute = $false
    $fixtureStart.CreateNoWindow = $true
    $fixtureChild = $null
    try {
        if ($MetadataChildrenDuringReadiness) {
            [OwnedMetadataChildren]::Start($fixtureStart.FileName)
            Start-Sleep -Milliseconds 6500
        }
        $fixtureChild = [System.Diagnostics.Process]::Start($fixtureStart)
        if ($TcpPort -gt 0) {
            if ((Read-FixtureLine $fixtureChild.StandardOutput) -ne 'listener_ready') { throw 'The owned descendant listener did not become ready.' }
            if (-not $SkipIdentity) {
                [Console]::Out.WriteLine([WindowsUiFixture]::Identity())
                [Console]::Out.Flush()
            }
        }
        if ($AncestorExitAfterClick) {
            [Console]::Out.WriteLine((Read-FixtureLine $fixtureChild.StandardOutput))
            [Console]::Out.Flush()
            if ((Read-FixtureLine ([Console]::In)) -ne 'ready') { throw 'The owned root did not acknowledge the GUI identity.' }
            $fixtureChild.StandardInput.WriteLine('ready')
            $fixtureChild.StandardInput.Flush()
        }
        while ($true) {
            $fixtureStop = [Console]::In.ReadLine()
            if ($fixtureStop -eq 'status') {
                [Console]::Out.WriteLine('{"event":"fixture_status","guiAlive":' + (-not $fixtureChild.HasExited).ToString().ToLowerInvariant() + ',"ancestorAlive":true}')
                [Console]::Out.Flush()
            }
            elseif ($fixtureStop -eq 'stop' -or $null -eq $fixtureStop) { break }
            else { throw 'The owned fixture received an unknown command.' }
        }
        if ($fixtureStop -eq 'stop' -and -not $fixtureChild.HasExited) {
            try { $null = $fixtureChild.CloseMainWindow() }
            catch { if (-not $fixtureChild.HasExited) { throw } }
        }
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
    if ($AwaitParentReady -and (Read-FixtureLine ([Console]::In)) -ne 'ready') { throw 'The owned parent did not release GUI readiness.' }
    $fixtureExitParent = $null
    if ($ExitParentPid -gt 0) { $fixtureExitParent = [WindowsUiFixture]::HoldIdentity($ExitParentPid, $ExitParentCreationTime) }
    $fixtureHelperExecutable = $null
    if ($HelperExitAfterClick) { $fixtureHelperExecutable = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    [WindowsUiFixture]::Run($Title, $DuplicateControl.IsPresent, $DuplicateWindow.IsPresent, $ExitAfterClick.IsPresent, $MixedControlTypes.IsPresent, $DuplicateButton.IsPresent, $fixtureHelperExecutable, $fixtureExitParent, $TracePublicInput.IsPresent, $BackgroundBeforeClick.IsPresent, $OccludeClick.IsPresent)
}
