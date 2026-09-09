# This entry runs only as a managed ProcessHost child in an exclusive interactive session.
# It never launches applications, switches desktops, uses global input, or searches desktop UIA.
# Synchronous UIA providers and PrintWindow can hang. The watchdog terminates this driver process
# on a hard deadline; the caller must treat missing output as incomplete, never as a passing run.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Web.Extensions
    $source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AgenticReview.WindowsUi {
  public sealed class Failure : Exception {
    public readonly string Code;
    public readonly string Outcome;
    public readonly string ObservationReason;
    public Failure(string code, string outcome, string message) : base(message) {
      Code = code; Outcome = outcome;
    }
    public Failure(string code, string outcome, string message, string observationReason) : this(code, outcome, message) {
      ObservationReason = observationReason;
    }
  }

  public sealed class OwnedProcess : IDisposable {
    public readonly uint Id;
    public readonly uint ParentId;
    public readonly ulong Created;
    public readonly IntPtr Handle;
    public OwnedProcess(uint id, uint parentId) {
      Id = id; ParentId = parentId;
      Handle = Native.OpenProcess(0x00101000, false, id);
      if (Handle == IntPtr.Zero) throw Driver.OwnershipFailure();
      ulong exited, kernel, user;
      if (!Native.GetProcessTimes(Handle, out Created, out exited, out kernel, out user)) {
        Native.CloseHandle(Handle); throw Driver.OwnershipFailure();
      }
    }
    public bool Alive { get { return Native.WaitForSingleObject(Handle, 0) == 258; } }
    public void Dispose() { Native.CloseHandle(Handle); }
  }

  public static class Native {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessEntry {
      public uint size, usage, processId;
      public UIntPtr defaultHeap;
      public uint moduleId, threads, parentProcessId;
      public int basePriority;
      public uint flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rectangle { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct FileInformation {
      public uint attributes; public long created, accessed, written;
      public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct SessionLevel1 {
      public uint sessionId; public int state, flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string stationName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string userName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string domainName;
      public long logon, connected, disconnected, lastInput, current;
      public uint incomingBytes, outgoingBytes, incomingFrames, outgoingFrames, incomingCompressed, outgoingCompressed;
    }
    [StructLayout(LayoutKind.Sequential)] public struct SessionInformation { public uint level; public SessionLevel1 data; }
    public delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out ulong created, out ulong exited, out ulong kernel, out ulong user);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder name, uint capacity, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetFileInformationByHandle(IntPtr file, out FileInformation info);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr context, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)] public static extern bool GetUserObjectBoolean(IntPtr handle, int index, out int information, int length, out int needed);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] public static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int informationClass, out IntPtr buffer, out int size);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("iphlpapi.dll")] public static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, int tableClass, uint reserved);
  }

  public sealed class Driver : IDisposable {
    sealed class PendingCapture {
      public readonly byte[] Bytes;
      public readonly Dictionary<string, object> Step;
      public PendingCapture(byte[] bytes, Dictionary<string, object> step) { Bytes = bytes; Step = step; }
    }
    const int InputLimit = 524288;
    const int OutputLimit = 524288;
    const int ScreenshotLimit = 16777216;
    const int TotalEvidenceLimit = 134217728;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = InputLimit, RecursionLimit = 32 };
    readonly Dictionary<uint, OwnedProcess> owned = new Dictionary<uint, OwnedProcess>();
    readonly HashSet<uint> live = new HashSet<uint>();
    readonly ArrayList files = new ArrayList();
    readonly List<PendingCapture> pendingCaptures = new List<PendingCapture>();
    readonly Timer watchdog;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Dictionary<string, object> request;
    readonly Dictionary<string, object> scenario;
    readonly Dictionary<string, object> readiness;
    readonly Dictionary<string, object> policy;
    readonly Dictionary<string, object> selector;
    readonly OwnedProcess root;
    readonly uint session;
    readonly ArrayList steps = new ArrayList();
    readonly HashSet<string> progressSteps = new HashSet<string>(StringComparer.Ordinal);
    readonly Dictionary<string, object> execution;
    readonly Dictionary<string, object> result;
    readonly string baseDirectory;
    readonly bool observationProtocol;
    bool mediaAllowed = true;
    string directory;
    string relativeDirectory;
    long totalBytes;
    long pendingCaptureBytes;
    long deadline;
    IntPtr readyWindow;
    uint readyThread;
    uint readyProcess;
    Dictionary<string, object> activeStep;

    public static Failure OwnershipFailure() { return new Failure("ownership_lost", "blocked", "The launched process identity or its live ancestry could not be verified."); }
    static Failure Unavailable() { return new Failure("interactive_session_unavailable", "blocked", "An active, unlocked interactive session on the input desktop is required."); }
    static void TerminateForDeadline(object state) {
      Console.Error.WriteLine("Windows UI driver hard deadline exceeded; evidence is incomplete.");
      Environment.Exit(124);
    }
    static Dictionary<string, object> Map(object value) {
      var map = value as Dictionary<string, object>;
      if (map == null) throw new ArgumentException("Expected an object.");
      return map;
    }
    static object[] List(object value) {
      var list = value as object[];
      if (list == null) throw new ArgumentException("Expected an array.");
      return list;
    }
    static void Keys(Dictionary<string, object> map, string required, string optional) {
      var allowed = new HashSet<string>((required + "," + optional).Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries), StringComparer.Ordinal);
      foreach (string key in required.Split(',')) if (key.Length > 0 && !map.ContainsKey(key)) throw new ArgumentException("Required property missing.");
      foreach (string key in map.Keys) if (!allowed.Contains(key)) throw new ArgumentException("Unexpected property.");
    }
    static string Text(object value, int minimum, int maximum, bool name) {
      string text = value as string;
      if (text == null || text.Length < minimum || text.Length > maximum || text.IndexOf('\0') >= 0) throw new ArgumentException("Invalid text bounds.");
      Utf8.GetByteCount(text);
      if (name) {
        if (String.IsNullOrWhiteSpace(text)) throw new ArgumentException("Empty name.");
        foreach (char character in text) if (character < 32 || character == 127) throw new ArgumentException("Invalid name.");
      }
      return text;
    }
    static long Number(object value, long minimum, long maximum) {
      if (!(value is int) && !(value is long)) throw new ArgumentException("Expected an integer.");
      long number = Convert.ToInt64(value, CultureInfo.InvariantCulture);
      if (number < minimum || number > maximum) throw new ArgumentException("Invalid integer bounds.");
      return number;
    }
    static bool Boolean(object value) { if (!(value is bool)) throw new ArgumentException("Expected a boolean."); return (bool)value; }
    static string OneOf(object value, string values) {
      string text = Text(value, 1, 128, true);
      if (Array.IndexOf(values.Split(','), text) < 0) throw new ArgumentException("Unsupported protocol value.");
      return text;
    }
    static string Id(object value) {
      string text = Text(value, 1, 128, true);
      if (!System.Text.RegularExpressions.Regex.IsMatch(text, "^[A-Za-z0-9][A-Za-z0-9._:-]*$")) throw new ArgumentException("Invalid identifier.");
      return text;
    }
    static Dictionary<string, object> Object(params object[] pairs) {
      var map = new Dictionary<string, object>(StringComparer.Ordinal);
      for (int index = 0; index < pairs.Length; index += 2) map.Add((string)pairs[index], pairs[index + 1]);
      return map;
    }
    static void Validate(Dictionary<string, object> input) {
      Keys(input, "schemaVersion,rootProcess,scenario,readiness,evidence,evidenceDirectory", "observationProtocol");
      OneOf(input["schemaVersion"], "WindowsDriverRequestV1");
      if (input.ContainsKey("observationProtocol")) OneOf(input["observationProtocol"], "UiAssertionCaptureV1");
      var identity = Map(input["rootProcess"]); Keys(identity, "pid,creationTimeFileTime", "");
      Number(identity["pid"], 1, UInt32.MaxValue);
      string fileTime = Text(identity["creationTimeFileTime"], 1, 20, false);
      ulong created;
      if (!System.Text.RegularExpressions.Regex.IsMatch(fileTime, "^[1-9][0-9]*$") || !UInt64.TryParse(fileTime, NumberStyles.None, CultureInfo.InvariantCulture, out created)) throw new ArgumentException("Invalid process identity.");
      string path = Text(input["evidenceDirectory"], 3, 32000, false);
      if (!System.Text.RegularExpressions.Regex.IsMatch(path, "^[A-Za-z]:[\\\\/]") || !Path.IsPathRooted(path)) throw new ArgumentException("Evidence needs a local absolute path.");
      foreach (char character in path) if (character < 32) throw new ArgumentException("Invalid evidence path.");
      var ready = Map(input["readiness"]); Keys(ready, "kind,window,timeoutMs", "");
      OneOf(ready["kind"], "window"); Number(ready["timeoutMs"], 1000, 120000);
      var window = Map(ready["window"]); Keys(window, "", "title,className,automationId");
      if (window.Count == 0) throw new ArgumentException("Window selector is empty.");
      foreach (object value in window.Values) Text(value, 1, 256, true);
      var evidence = Map(input["evidence"]); Keys(evidence, "screenshots,screenshotScope,required", "");
      OneOf(evidence["screenshots"], "on_failure,every_assertion");
      OneOf(evidence["screenshotScope"], "owned_window");
      if (!Boolean(evidence["required"])) throw new ArgumentException("Evidence is required.");
      var configured = Map(input["scenario"]); Keys(configured, "id,name,required,timeoutMs,steps", "");
      var ids = new HashSet<string>(StringComparer.Ordinal); ids.Add(Id(configured["id"]));
      Text(configured["name"], 1, 256, true); Boolean(configured["required"]);
      long budget = Number(configured["timeoutMs"], 1000, 600000);
      var operations = List(configured["steps"]);
      if (operations.Length < 1 || operations.Length > 32) throw new ArgumentException("Invalid operation count.");
      int assertions = 0;
      foreach (object raw in operations) {
        var step = Map(raw);
        string action = OneOf(step["action"], "click,fill,assertVisible,assertText,assertValue");
        Keys(step, "id,name,timeoutMs,locator,action" + (action == "fill" ? ",value" : action.StartsWith("assert", StringComparison.Ordinal) ? ",expected" : "") + (action == "assertText" ? ",match" : ""), "");
        if (!ids.Add(Id(step["id"]))) throw new ArgumentException("Duplicate operation identifier.");
        Text(step["name"], 1, 256, true); Number(step["timeoutMs"], 100, Math.Min(60000, budget));
        var locator = Map(step["locator"]);
        string by = OneOf(locator["by"], "automationId,name");
        Keys(locator, by == "automationId" ? "by,automationId" : "by,controlType,name", by == "automationId" ? "controlType" : "");
        Text(locator[by], 1, 256, true);
        if (locator.ContainsKey("controlType")) OneOf(locator["controlType"], "Button,Edit,Text,CheckBox,ComboBox,ListItem,Window,Pane,TabItem");
        if (action == "fill") Text(step["value"], 0, 2048, false);
        if (action.StartsWith("assert", StringComparison.Ordinal)) {
          assertions++;
          if (action == "assertVisible") Boolean(step["expected"]); else Text(step["expected"], 0, 2048, false);
        }
        if (input.ContainsKey("observationProtocol") &&
            ((action == "fill" && !SafeObservationText((string)step["value"])) ||
             (step.ContainsKey("expected") && step["expected"] is string && !SafeObservationText((string)step["expected"]))))
          throw new ArgumentException("Mapped UI input cannot contain protected values.");
        if (action == "assertText" && OneOf(step["match"], "exact,contains") == "contains" && ((string)step["expected"]).Length == 0) throw new ArgumentException("Empty contains assertion.");
      }
      if (assertions == 0) throw new ArgumentException("A deterministic assertion is required.");
    }

    Driver(Dictionary<string, object> input, Timer timer) {
      request = input; scenario = Map(input["scenario"]); readiness = Map(input["readiness"]);
      observationProtocol = input.ContainsKey("observationProtocol");
      policy = Map(input["evidence"]); selector = Map(readiness["window"]); watchdog = timer;
      baseDirectory = Path.GetFullPath((string)input["evidenceDirectory"]);
      var identity = Map(input["rootProcess"]);
      root = new OwnedProcess((uint)Number(identity["pid"], 1, UInt32.MaxValue), 0);
      owned.Add(root.Id, root);
      if (root.Created != UInt64.Parse((string)identity["creationTimeFileTime"], CultureInfo.InvariantCulture) || !root.Alive) throw OwnershipFailure();
      if (!Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session) || session == 0) throw Unavailable();
      uint rootSession;
      if (!Native.ProcessIdToSessionId(root.Id, out rootSession) || rootSession != session) throw OwnershipFailure();
      foreach (object raw in List(scenario["steps"])) {
        var planned = Map(raw); string action = (string)planned["action"];
        var observed = Object("stepId", planned["id"], "name", planned["name"], "action", action,
          "outcome", "not_run", "summary", "The operation was not reached.", "expected", planned.ContainsKey("expected") ? planned["expected"] : null,
          "actual", null, "evidenceIds", new ArrayList());
        UnavailableActual(observed, "not_run"); steps.Add(observed);
      }
      execution = Object("schemaVersion", "UiScenarioExecutionEvidenceV1", "source", "ui_driver", "scenarioId", scenario["id"], "target", "windows_desktop", "steps", steps);
      result = Object("schemaVersion", "WindowsDriverResultV1", "scenarioId", scenario["id"], "outcome", "passed", "reasonCode", "completed",
        "summary", "Every configured UI operation and assertion passed.", "evidenceComplete", false, "execution", execution, "evidenceFiles", files);
    }

    void Arm(long maximum) {
      long remaining = deadline - clock.ElapsedMilliseconds;
      if (remaining <= 0) throw new Failure("scenario_timeout", "inconclusive", "The scenario exceeded its total time budget.");
      watchdog.Change((int)Math.Min(maximum, remaining), Timeout.Infinite);
    }
    static string UserObjectName(IntPtr handle) {
      var buffer = new StringBuilder(512); int needed;
      if (handle == IntPtr.Zero || !Native.GetUserObjectInformation(handle, 2, buffer, 1024, out needed)) throw Unavailable();
      return buffer.ToString();
    }
    static void VerifyInteractive(uint session) {
      if (!Environment.UserInteractive || session == 0) throw Unavailable();
      IntPtr state; int size;
      if (!Native.WTSQuerySessionInformation(IntPtr.Zero, session, 8, out state, out size)) throw Unavailable();
      try { if (size != 4 || Marshal.ReadInt32(state) != 0) throw Unavailable(); }
      finally { Native.WTSFreeMemory(state); }
      if (!Native.WTSQuerySessionInformation(IntPtr.Zero, session, 25, out state, out size)) throw Unavailable();
      try {
        if (size < Marshal.SizeOf(typeof(Native.SessionInformation))) throw Unavailable();
        var info = (Native.SessionInformation)Marshal.PtrToStructure(state, typeof(Native.SessionInformation));
        if (info.level != 1 || info.data.sessionId != session || info.data.state != 0 || info.data.flags != 1) throw Unavailable();
      } finally { Native.WTSFreeMemory(state); }
      if (!String.Equals(UserObjectName(Native.GetProcessWindowStation()), "WinSta0", StringComparison.OrdinalIgnoreCase)) throw Unavailable();
      IntPtr desktop = Native.OpenInputDesktop(0, false, 1);
      if (desktop == IntPtr.Zero) throw Unavailable();
      try {
        string inputName = UserObjectName(desktop);
        IntPtr threadDesktop = Native.GetThreadDesktop(Native.GetCurrentThreadId()); int receivesInput, needed;
        if (!Native.GetUserObjectBoolean(threadDesktop, 6, out receivesInput, 4, out needed) || receivesInput == 0) throw Unavailable();
        // Secure Winlogon/UAC and alternate desktops are intentionally unsupported.
        if (!String.Equals(inputName, "Default", StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(inputName, UserObjectName(threadDesktop), StringComparison.OrdinalIgnoreCase)) throw Unavailable();
      } finally { Native.CloseDesktop(desktop); }
    }
    void Interactive() { VerifyInteractive(session); }
    static Dictionary<uint, uint> SnapshotParents() {
      IntPtr snapshot = Native.CreateToolhelp32Snapshot(2, 0);
      if (snapshot == new IntPtr(-1)) throw OwnershipFailure();
      var parents = new Dictionary<uint, uint>();
      try {
        var entry = new Native.ProcessEntry(); entry.size = (uint)Marshal.SizeOf(entry);
        if (!Native.Process32FirstW(snapshot, ref entry)) throw OwnershipFailure();
        do { parents[entry.processId] = entry.parentProcessId; } while (Native.Process32NextW(snapshot, ref entry));
        if (Marshal.GetLastWin32Error() != 18) throw OwnershipFailure();
      } finally { Native.CloseHandle(snapshot); }
      return parents;
    }
    void RefreshOwnership() {
      Interactive();
      RefreshOwnedProcesses(owned, live, root, session);
    }
    static void RefreshOwnedProcesses(Dictionary<uint, OwnedProcess> owned, HashSet<uint> live, OwnedProcess root, uint session) {
      if (!root.Alive) throw OwnershipFailure();
      var parents = SnapshotParents();
      if (!parents.ContainsKey(root.Id)) throw OwnershipFailure();
      live.Clear(); live.Add(root.Id);
      bool changed;
      do {
        changed = false;
        foreach (var pair in parents) {
          if (live.Contains(pair.Key) || !live.Contains(pair.Value)) continue;
          OwnedProcess parent = owned[pair.Value];
          if (!parent.Alive) throw OwnershipFailure();
          OwnedProcess child;
          if (!owned.TryGetValue(pair.Key, out child)) {
            if (owned.Count >= 128) throw OwnershipFailure();
            child = new OwnedProcess(pair.Key, pair.Value); owned.Add(pair.Key, child);
          }
          uint childSession;
          if (!child.Alive || child.ParentId != parent.Id || child.Created < parent.Created || !parent.Alive ||
              !Native.ProcessIdToSessionId(child.Id, out childSession) || childSession != session) throw OwnershipFailure();
          live.Add(child.Id); changed = true;
        }
      } while (changed);
      // Opening a PID from the first snapshot can race that process exiting and its PID being
      // reused. A fresh snapshot after every candidate handle is held must confirm every edge.
      // The retained handles now pin those process identities until the scenario ends.
      var confirmed = SnapshotParents();
      foreach (uint processId in live) {
        OwnedProcess process = owned[processId]; uint parentId;
        if (!process.Alive || !confirmed.TryGetValue(processId, out parentId)) throw OwnershipFailure();
        if (processId != root.Id && (parentId != process.ParentId || !live.Contains(parentId) || !owned[parentId].Alive)) throw OwnershipFailure();
      }
      if (!root.Alive) throw OwnershipFailure();
    }
    static object ProbeSession(Dictionary<string, object> input) {
      Keys(input, "schemaVersion", "");
      uint sessionId = 0;
      try {
        if (!Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out sessionId)) throw Unavailable();
        VerifyInteractive(sessionId);
        return Object("schemaVersion", "WindowsSessionProbeResultV1", "available", true, "sessionId", sessionId, "reasonCode", "ready");
      } catch (Failure) {
        return Object("schemaVersion", "WindowsSessionProbeResultV1", "available", false, "sessionId", null, "reasonCode", "interactive_session_unavailable");
      }
    }
    static List<uint> TcpListeners(int port) {
      uint size = 0;
      uint status = Native.GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
      if (status != 122 || size < 4 || size > 4194304) throw new IOException("TCP ownership table is unavailable.");
      for (int attempt = 0; attempt < 3; attempt++) {
        uint capacity = size;
        if (capacity < 4 || capacity > 4194304) throw new IOException("TCP ownership table exceeded its bounds.");
        IntPtr table = Marshal.AllocHGlobal((int)capacity);
        try {
          status = Native.GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
          if (status == 122) continue;
          if (status != 0 || size > capacity) throw new IOException("TCP ownership query failed.");
          int count = Marshal.ReadInt32(table);
          if (count < 0 || 4L + 24L * count > capacity) throw new IOException("TCP ownership rows are invalid.");
          var owners = new List<uint>();
          for (int index = 0; index < count; index++) {
            IntPtr row = IntPtr.Add(table, 4 + index * 24);
            uint state = unchecked((uint)Marshal.ReadInt32(row, 0));
            uint address = unchecked((uint)Marshal.ReadInt32(row, 4));
            uint networkPort = unchecked((uint)Marshal.ReadInt32(row, 8));
            int localPort = (int)(((networkPort & 255) << 8) | ((networkPort >> 8) & 255));
            if (state == 2 && (address == 0 || address == 0x0100007f) && localPort == port) owners.Add(unchecked((uint)Marshal.ReadInt32(row, 20)));
          }
          return owners;
        } finally { Marshal.FreeHGlobal(table); }
      }
      throw new IOException("TCP ownership table changed repeatedly.");
    }
    static object ProbeTcp(Dictionary<string, object> input) {
      Keys(input, "schemaVersion,rootProcess,port", "");
      var identity = Map(input["rootProcess"]); Keys(identity, "pid,creationTimeFileTime", "");
      uint pid = (uint)Number(identity["pid"], 1, UInt32.MaxValue);
      string fileTime = Text(identity["creationTimeFileTime"], 1, 20, false); ulong created;
      if (!System.Text.RegularExpressions.Regex.IsMatch(fileTime, "^[1-9][0-9]*$") || !UInt64.TryParse(fileTime, NumberStyles.None, CultureInfo.InvariantCulture, out created)) throw new ArgumentException("Invalid process identity.");
      int port = (int)Number(input["port"], 1, 65535);
      string reason = "probe_unavailable";
      var owned = new Dictionary<uint, OwnedProcess>(); var live = new HashSet<uint>();
      try {
        var root = new OwnedProcess(pid, 0); owned.Add(pid, root);
        uint sessionId, currentSession;
        if (root.Created != created || !Native.ProcessIdToSessionId(pid, out sessionId) ||
            !Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out currentSession) || sessionId != currentSession) throw OwnershipFailure();
        RefreshOwnedProcesses(owned, live, root, sessionId);
        var listeners = TcpListeners(port);
        if (listeners.Count == 0) reason = "not_listening";
        else if (listeners.Count > 1) reason = "ambiguous_listener";
        else if (!live.Contains(listeners[0])) reason = "unowned_listener";
        else {
          RefreshOwnedProcesses(owned, live, root, sessionId);
          var confirmed = TcpListeners(port);
          reason = confirmed.Count == 1 && confirmed[0] == listeners[0] && live.Contains(confirmed[0]) && owned[confirmed[0]].Alive ? "owned" : "ownership_lost";
        }
      } catch (Failure) { reason = "ownership_lost"; }
        catch { reason = "probe_unavailable"; }
      finally { foreach (var process in owned.Values) process.Dispose(); }
      return Object("schemaVersion", "WindowsTcpOwnerProbeResultV1", "rootProcess", identity, "port", port, "owned", reason == "owned", "reasonCode", reason);
    }
    void OwnedWindow(IntPtr window) {
      uint processId; uint thread = Native.GetWindowThreadProcessId(window, out processId);
      if (!Native.IsWindow(window) || thread == 0 ||
          !live.Contains(processId) || !owned[processId].Alive || !root.Alive) throw OwnershipFailure();
      if (window == readyWindow && readyThread != 0 && (thread != readyThread || processId != readyProcess)) throw OwnershipFailure();
    }
    IntPtr FindWindow(bool requirePinned) {
      RefreshOwnership();
      var matches = new List<IntPtr>(); Failure callbackFailure = null;
      bool enumerated = Native.EnumWindows(delegate(IntPtr window, IntPtr ignored) {
        try {
          uint processId; Native.GetWindowThreadProcessId(window, out processId);
          if (!live.Contains(processId) || !Native.IsWindowVisible(window)) return true;
          OwnedWindow(window);
          var text = new StringBuilder(1024);
          if (selector.ContainsKey("title")) { Native.GetWindowText(window, text, text.Capacity); if (text.ToString() != (string)selector["title"]) return true; }
          if (selector.ContainsKey("className")) { text.Clear(); Native.GetClassName(window, text, text.Capacity); if (text.ToString() != (string)selector["className"]) return true; }
          if (selector.ContainsKey("automationId")) {
            var element = AutomationElement.FromHandle(window);
            if (element == null || element.Current.AutomationId != (string)selector["automationId"]) return true;
            if ((uint)element.Current.ProcessId != processId) throw OwnershipFailure();
          }
          OwnedWindow(window); matches.Add(window); return true;
        } catch (Failure failure) { callbackFailure = failure; return false; }
          catch { callbackFailure = new Failure("provider_unavailable", "blocked", "The owned window automation provider is unavailable."); return false; }
      }, IntPtr.Zero);
      if (callbackFailure != null) throw callbackFailure;
      if (!enumerated) throw OwnershipFailure();
      if (matches.Count > 1) throw new Failure("ambiguous_window", "blocked", "The readiness selector matched multiple owned windows.");
      if (matches.Count == 0) {
        if (requirePinned) throw new Failure("window_unavailable", "blocked", "The selected owned window is no longer available.");
        return IntPtr.Zero;
      }
      if (requirePinned && matches[0] != readyWindow) throw OwnershipFailure();
      OwnedWindow(matches[0]); return matches[0];
    }
    void VerifyElement(AutomationElement element) {
      OwnedWindow(readyWindow);
      uint processId = (uint)element.Current.ProcessId;
      if (!live.Contains(processId) || !owned[processId].Alive) throw OwnershipFailure();
      var ancestor = element;
      for (int depth = 0; depth < 256 && ancestor != null; depth++) {
        uint ancestorProcess = (uint)ancestor.Current.ProcessId;
        if (!live.Contains(ancestorProcess) || !owned[ancestorProcess].Alive) throw OwnershipFailure();
        if (ancestor.Current.NativeWindowHandle == readyWindow.ToInt32()) return;
        ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
      }
      throw OwnershipFailure();
    }
    AutomationElement Locate(Dictionary<string, object> locator) {
      FindWindow(true);
      var window = AutomationElement.FromHandle(readyWindow);
      if (window == null) throw OwnershipFailure();
      VerifyElement(window);
      string by = (string)locator["by"];
      Condition condition = new PropertyCondition(by == "automationId" ? AutomationElement.AutomationIdProperty : AutomationElement.NameProperty, locator[by]);
      if (locator.ContainsKey("controlType")) {
        var field = typeof(ControlType).GetField((string)locator["controlType"]);
        if (field == null) throw new Failure("unsupported_control", "blocked", "The configured control type is unsupported.");
        condition = new AndCondition(condition, new PropertyCondition(AutomationElement.ControlTypeProperty, field.GetValue(null)));
      }
      var elements = window.FindAll(TreeScope.Subtree, condition);
      FindWindow(true); VerifyElement(window);
      if (elements.Count > 1) throw new Failure("ambiguous_locator", "blocked", "The locator matched multiple elements inside the owned window.");
      if (elements.Count == 0) return null;
      VerifyElement(elements[0]); return elements[0];
    }
    static bool SafeObservationText(string value) {
      if (value.Length > 2048) return false;
      try { Utf8.GetByteCount(value); } catch { return false; }
      if (System.Text.RegularExpressions.Regex.IsMatch(value, @"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")) return false;
      string[] patterns = {
        @"(?i)\[REDACTED(?:[^\]]*)\]",
        @"(?i)(?<![A-Za-z0-9_])(?:authorization|proxy-authorization|cookie|set-cookie)[""']?\s*[:=]",
        @"-----BEGIN [^-]*PRIVATE KEY-----",
        @"(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|arw1_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_])",
        @"(?i)(?<![A-Za-z0-9_])(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+",
        @"(?i)[a-z][a-z0-9+.-]*://[^\s/@]+:[^\s/@]+@",
        @"(?i)[""']?[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[A-Za-z0-9_-]*[""']?\s*[:=]\s*(?:""[^""\r\n]*""|'[^'\r\n]*'|[^\s,;]+)",
        @"(?i)--?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s+(?:""[^""\r\n]*""|'[^'\r\n]*'|[^\s,;]+)"
      };
      foreach (string pattern in patterns) if (System.Text.RegularExpressions.Regex.IsMatch(value, pattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant)) return false;
      return true;
    }
    void UnavailableActual(Dictionary<string, object> observed, string reason) {
      if (!((string)observed["action"]).StartsWith("assert", StringComparison.Ordinal)) return;
      observed["actual"] = null;
      if (observationProtocol) observed["capture"] = Object("schemaVersion", "UiAssertionCaptureV1", "state", "unavailable", "reason", reason);
    }
    void CompleteActual(Dictionary<string, object> observed, object actual) {
      observed["actual"] = actual;
      if (observationProtocol) observed["capture"] = Object("schemaVersion", "UiAssertionCaptureV1", "state", "complete");
    }
    string BoundedActual(string actual) {
      if (actual != null && actual.Length > 2048) throw new Failure("provider_unavailable", "blocked", "The control value exceeded the bounded evidence protocol.", "oversized_value");
      if (actual == null || actual.IndexOf('\0') >= 0) throw new Failure("provider_unavailable", "blocked", "The control value could not supply valid evidence.", "provider_error");
      Utf8.GetByteCount(actual);
      if (!SafeObservationText(actual)) {
        mediaAllowed = false;
        throw new Failure("provider_unavailable", "blocked", "The control value cannot be safely retained as evidence.", "unsafe_value");
      }
      return actual;
    }
    void VerifyObservationElement(Dictionary<string, object> locator, AutomationElement element) {
      var current = Locate(locator);
      if ((element == null) != (current == null) || (element != null && !Automation.Compare(element, current)))
        throw new Failure("provider_unavailable", "blocked", "The locator changed while its observation was being captured.", "provider_error");
    }
    void Perform(Dictionary<string, object> planned, Dictionary<string, object> observed) {
      string action = (string)planned["action"];
      long stepDeadline = Math.Min(deadline, clock.ElapsedMilliseconds + Number(planned["timeoutMs"], 100, 60000));
      Arm(stepDeadline - clock.ElapsedMilliseconds);
      do {
        long sampleStarted = clock.ElapsedMilliseconds;
        UnavailableActual(observed, "provider_error");
        var locator = Map(planned["locator"]);
        AutomationElement element = Locate(locator);
        bool assertion = action.StartsWith("assert", StringComparison.Ordinal);
        bool matched = false;
        if (action == "assertVisible") {
          bool visible = element != null && !element.Current.IsOffscreen && !element.Current.BoundingRectangle.IsEmpty;
          VerifyObservationElement(locator, element);
          CompleteActual(observed, visible); matched = visible == (bool)planned["expected"];
        } else if (element != null) {
          VerifyElement(element);
          if (action == "click" || action == "fill") {
            if (!element.Current.IsEnabled || element.Current.IsOffscreen || element.Current.IsPassword) throw new Failure("unsupported_control", "blocked", "The target must be enabled, visible, and non-secret.");
            object pattern;
            // Revalidate the root, every ancestry edge, the unique window, and this element
            // immediately before a provider call that can mutate application state.
            FindWindow(true); VerifyElement(element);
            if (action == "click") {
              if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new Failure("unsupported_control", "blocked", "Click requires the UI Automation Invoke pattern.");
              FindWindow(true); VerifyElement(element); ((InvokePattern)pattern).Invoke();
            } else {
              if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) throw new Failure("unsupported_control", "blocked", "Fill requires a writable UI Automation Value pattern.");
              FindWindow(true); VerifyElement(element); ((ValuePattern)pattern).SetValue((string)planned["value"]);
            }
            FindWindow(true); matched = true;
          } else if (action == "assertText") {
            if (element.Current.IsPassword) throw new Failure("unsupported_control", "blocked", "Secret controls cannot be recorded.");
            // UIA Name is the accessible label/text contract; TextPattern document extraction
            // and arbitrary descendant concatenation are deliberately outside this protocol.
            string actual = BoundedActual(element.Current.Name); VerifyObservationElement(locator, element); CompleteActual(observed, actual);
            matched = (string)planned["match"] == "exact" ? actual == (string)planned["expected"] : actual.IndexOf((string)planned["expected"], StringComparison.Ordinal) >= 0;
          } else if (action == "assertValue") {
            object pattern;
            if (element.Current.IsPassword || !element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) throw new Failure("unsupported_control", "blocked", "Value assertions require a non-secret UI Automation Value pattern.");
            string actual = BoundedActual(((ValuePattern)pattern).Current.Value); VerifyObservationElement(locator, element); CompleteActual(observed, actual); matched = actual == (string)planned["expected"];
          }
        } else if (assertion) UnavailableActual(observed, "missing_element");
        if (matched) {
          FindWindow(true); observed["outcome"] = "passed";
          observed["summary"] = assertion ? "The observed UI value matched the configured assertion." : "The requested UI Automation operation completed.";
          return;
        }
        long nextSampleBudget = Math.Max(150, clock.ElapsedMilliseconds - sampleStarted + 100);
        if (clock.ElapsedMilliseconds >= stepDeadline - nextSampleBudget) break;
        Thread.Sleep(75);
      } while (clock.ElapsedMilliseconds < stepDeadline);
      if (clock.ElapsedMilliseconds >= deadline) throw new Failure("scenario_timeout", "inconclusive", "The scenario exceeded its total time budget.", "timeout");
      if (action.StartsWith("assert", StringComparison.Ordinal) && observed["actual"] == null)
        throw new Failure("provider_unavailable", "blocked", "The locator did not supply an observable control within the step budget.", "missing_element");
      throw new Failure(action.StartsWith("assert", StringComparison.Ordinal) ? "assertion_failed" : "action_failed", "failed", "The configured UI operation did not meet its expected state within the step budget.");
    }

    static void CheckDirectory(string path) {
      var info = new DirectoryInfo(path);
      while (info != null) {
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Evidence directories cannot be links.");
        info = info.Parent;
      }
    }
    void PrepareDirectory() {
      CheckDirectory(baseDirectory);
      relativeDirectory = "windows-" + Guid.NewGuid().ToString("D");
      directory = Path.Combine(baseDirectory, relativeDirectory);
      if (Directory.Exists(directory) || File.Exists(directory)) throw new IOException("Evidence directory already exists.");
      Directory.CreateDirectory(directory); CheckDirectory(directory);
    }
    // Match JSON.stringify for the bounded evidence graph, including its exact string escaping.
    static string CanonicalJson(object value) {
      var output = new StringBuilder(); WriteCanonicalJson(output, value); return output.ToString();
    }
    static void WriteCanonicalJson(StringBuilder output, object value) {
      if (value == null) { output.Append("null"); return; }
      var text = value as string;
      if (text != null) {
        output.Append('"');
        foreach (char character in text) {
          switch (character) {
            case '"': output.Append("\\\""); break;
            case '\\': output.Append("\\\\"); break;
            case '\b': output.Append("\\b"); break;
            case '\f': output.Append("\\f"); break;
            case '\n': output.Append("\\n"); break;
            case '\r': output.Append("\\r"); break;
            case '\t': output.Append("\\t"); break;
            default:
              if (character < 32) output.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
              else output.Append(character);
              break;
          }
        }
        output.Append('"'); return;
      }
      if (value is bool) { output.Append((bool)value ? "true" : "false"); return; }
      var map = value as Dictionary<string, object>;
      if (map != null) {
        output.Append('{'); bool first = true;
        foreach (var pair in map) {
          if (!first) output.Append(','); first = false;
          WriteCanonicalJson(output, pair.Key); output.Append(':'); WriteCanonicalJson(output, pair.Value);
        }
        output.Append('}'); return;
      }
      var list = value as IList;
      if (list != null) {
        output.Append('[');
        for (int index = 0; index < list.Count; index++) { if (index != 0) output.Append(','); WriteCanonicalJson(output, list[index]); }
        output.Append(']'); return;
      }
      throw new ArgumentException("Unsupported evidence value.");
    }
    string AddAsset(byte[] bytes, string kind) {
      int maximum = kind == "screenshot" ? ScreenshotLimit : OutputLimit;
      if (directory == null || bytes.Length < 1 || bytes.Length > maximum || totalBytes + bytes.Length > TotalEvidenceLimit) throw new IOException("Evidence exceeded its budget.");
      CheckDirectory(directory);
      string id = Guid.NewGuid().ToString("D"); string suffix = kind == "screenshot" ? ".png" : ".json";
      string path = Path.Combine(directory, id + suffix);
      bool created = false;
      try { using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
        created = true;
        var final = new StringBuilder(32768);
        uint count = Native.GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(), final, (uint)final.Capacity, 0);
        Native.FileInformation info;
        if (count == 0 || count >= final.Capacity || !String.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase) ||
            !Native.GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(), out info) || info.links != 1 || (info.attributes & 0x400) != 0) throw new IOException("Evidence file identity is invalid.");
        file.Write(bytes, 0, bytes.Length); file.Flush(true);
      } } catch {
        if (observationProtocol && created) { CheckDirectory(directory); File.Delete(path); }
        throw;
      }
      string hash;
      using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
      totalBytes += bytes.Length;
      files.Add(Object("id", id, "relativePath", relativeDirectory + "/" + id + suffix, "kind", kind,
        "mediaType", kind == "screenshot" ? "image/png" : "application/json", "sizeBytes", bytes.Length, "sha256", hash));
      return id;
    }
    void DiscardMedia() {
      pendingCaptures.Clear(); pendingCaptureBytes = 0;
      foreach (Dictionary<string, object> step in steps) ((ArrayList)step["evidenceIds"]).Clear();
      for (int index = files.Count - 1; index >= 0; index--) {
        var asset = (Dictionary<string, object>)files[index];
        if ((string)asset["kind"] != "screenshot") continue;
        CheckDirectory(directory);
        string path = Path.GetFullPath(Path.Combine(directory, (string)asset["id"] + ".png"));
        if (!String.Equals(Path.GetDirectoryName(path), directory, StringComparison.OrdinalIgnoreCase))
          throw new IOException("Media cleanup escaped its private evidence directory.");
        File.Delete(path);
        totalBytes -= Convert.ToInt64(asset["sizeBytes"], CultureInfo.InvariantCulture);
        files.RemoveAt(index);
      }
    }
    void FinalizeMedia() {
      foreach (var capture in pendingCaptures) {
        string id = AddAsset(capture.Bytes, "screenshot");
        if (capture.Step != null) ((ArrayList)capture.Step["evidenceIds"]).Add(id);
      }
      pendingCaptures.Clear(); pendingCaptureBytes = 0;
    }
    void Capture(Dictionary<string, object> observed) {
      if (!mediaAllowed) throw new IOException("Unsafe observations prevent media capture.");
      Arm(10000); FindWindow(true);
      if (Native.IsIconic(readyWindow)) throw new IOException("Minimized windows cannot supply visual evidence.");
      // PrintWindow asks the owning application to render. Match that application's DPI
      // context while measuring and painting, including applications virtualized at 96 DPI.
      IntPtr targetDpi = Native.GetWindowDpiAwarenessContext(readyWindow);
      IntPtr previousDpi = targetDpi == IntPtr.Zero ? IntPtr.Zero : Native.SetThreadDpiAwarenessContext(targetDpi);
      if (previousDpi == IntPtr.Zero) throw new IOException("Window DPI context is unavailable.");
      byte[] image;
      try {
        Native.Rectangle rectangle;
        if (!Native.GetWindowRect(readyWindow, out rectangle)) throw new IOException("Window bounds are unavailable.");
        long width = (long)rectangle.right - rectangle.left, height = (long)rectangle.bottom - rectangle.top;
        if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8388608) throw new IOException("Window bounds exceed capture limits.");
        using (var bitmap = new Bitmap((int)width, (int)height, PixelFormat.Format32bppArgb)) {
          using (var graphics = Graphics.FromImage(bitmap)) {
            IntPtr context = graphics.GetHdc();
            try { OwnedWindow(readyWindow); if (!Native.PrintWindow(readyWindow, context, 0)) throw new IOException("Window rendering failed."); }
            finally { graphics.ReleaseHdc(context); }
          }
          using (var bytes = new MemoryStream()) { bitmap.Save(bytes, ImageFormat.Png); image = bytes.ToArray(); }
        }
      } finally { Native.SetThreadDpiAwarenessContext(previousDpi); }
      FindWindow(true);
      if (observationProtocol) {
        if (image.Length < 1 || image.Length > ScreenshotLimit || pendingCaptureBytes + totalBytes + image.Length > TotalEvidenceLimit)
          throw new IOException("Pending screenshots exceeded their bounded evidence budget.");
        pendingCaptures.Add(new PendingCapture(image, observed)); pendingCaptureBytes += image.Length;
      } else {
        string id = AddAsset(image, "screenshot");
        if (observed != null) ((ArrayList)observed["evidenceIds"]).Add(id);
      }
    }
    void Failed(Failure failure) {
      result["outcome"] = failure.Outcome; result["reasonCode"] = failure.Code; result["summary"] = failure.Message;
      if (activeStep != null) {
        if (failure.Code != "assertion_failed") {
          string reason = failure.ObservationReason ??
            (failure.Code == "ambiguous_window" || failure.Code == "ambiguous_locator" ? "ambiguous_element" :
             failure.Code == "unsupported_control" ? "unsupported_control" :
             failure.Code == "scenario_timeout" ? "timeout" :
             failure.Code == "evidence_failed" ? "capture_failed" : "provider_error");
          UnavailableActual(activeStep, reason);
        }
        activeStep["outcome"] = failure.Outcome; activeStep["summary"] = failure.Message;
      }
    }
    void Progress(Dictionary<string, object> step) {
      if (step == null || !progressSteps.Add((string)step["stepId"])) return;
      Console.Error.WriteLine(Json.Serialize(Object("type", "ui_step_completed", "scenarioId", scenario["id"], "stepId", step["stepId"], "outcome", step["outcome"])));
      Console.Error.Flush();
    }
    object Run() {
      bool complete = true;
      deadline = clock.ElapsedMilliseconds + Number(readiness["timeoutMs"], 1000, 120000);
      try {
        Arm(deadline - clock.ElapsedMilliseconds); PrepareDirectory();
        while ((readyWindow = FindWindow(false)) == IntPtr.Zero) {
          if (clock.ElapsedMilliseconds >= deadline - 100) throw new Failure("window_unavailable", "blocked", "No unique owned window became ready within the startup budget.");
          Thread.Sleep(75);
        }
        readyThread = Native.GetWindowThreadProcessId(readyWindow, out readyProcess);
        OwnedWindow(readyWindow);
        deadline = clock.ElapsedMilliseconds + Number(scenario["timeoutMs"], 1000, 600000);
        var configuredSteps = List(scenario["steps"]);
        for (int index = 0; index < configuredSteps.Length; index++) {
          activeStep = (Dictionary<string, object>)steps[index];
          var planned = Map(configuredSteps[index]);
          Perform(planned, activeStep);
          var completedStep = activeStep; activeStep = null;
          if ((string)policy["screenshots"] == "every_assertion" && ((string)planned["action"]).StartsWith("assert", StringComparison.Ordinal)) Capture(completedStep);
          Progress(completedStep);
        }
        Arm(10000); FindWindow(true);
      } catch (Failure failure) {
        Failed(failure);
        if (!mediaAllowed || readyWindow == IntPtr.Zero || failure.Code == "ownership_lost" || failure.Code == "interactive_session_unavailable" ||
            (observationProtocol && failure.Code != "assertion_failed" && failure.Code != "action_failed")) complete = false;
        else {
          try { Capture(activeStep); } catch { complete = false; }
        }
      } catch (IOException) {
        Failed(new Failure("evidence_failed", "blocked", "Required owned-window evidence could not be finalized.")); complete = false;
      } catch {
        Failed(new Failure("provider_unavailable", "blocked", "The owned UI Automation provider could not complete the operation.")); complete = false;
      }
      Progress(activeStep);
      if (observationProtocol) {
        try {
          watchdog.Change(10000, Timeout.Infinite);
          if (complete && mediaAllowed) FinalizeMedia(); else DiscardMedia();
        } catch {
          complete = false;
          try { DiscardMedia(); } catch { }
          result["outcome"] = "blocked"; result["reasonCode"] = "evidence_failed";
          result["summary"] = "Required owned-window evidence could not be finalized.";
        }
      }
      try {
        watchdog.Change(10000, Timeout.Infinite);
        AddAsset(Utf8.GetBytes(observationProtocol ? CanonicalJson(execution) : Json.Serialize(execution)), "ui_steps");
      } catch {
        complete = false;
        if (observationProtocol) { try { DiscardMedia(); } catch { } }
        result["outcome"] = "blocked"; result["reasonCode"] = "evidence_failed";
        result["summary"] = "Required step evidence could not be finalized.";
      }
      result["evidenceComplete"] = complete;
      return result;
    }
    public void Dispose() { foreach (var process in owned.Values) process.Dispose(); }

    static object StartupFailure(Dictionary<string, object> request, Failure failure) {
      var scenario = Map(request["scenario"]); var steps = new ArrayList();
      foreach (object raw in List(scenario["steps"])) {
        var step = Map(raw);
        var observed = Object("stepId", step["id"], "name", step["name"], "action", step["action"], "outcome", "not_run",
          "summary", "The operation was not reached.", "expected", step.ContainsKey("expected") ? step["expected"] : null, "actual", null, "evidenceIds", new ArrayList());
        if (request.ContainsKey("observationProtocol") && ((string)step["action"]).StartsWith("assert", StringComparison.Ordinal))
          observed["capture"] = Object("schemaVersion", "UiAssertionCaptureV1", "state", "unavailable", "reason", "not_run");
        steps.Add(observed);
      }
      return Object("schemaVersion", "WindowsDriverResultV1", "scenarioId", scenario["id"], "outcome", failure.Outcome, "reasonCode", failure.Code,
        "summary", failure.Message, "evidenceComplete", false, "evidenceFiles", new ArrayList(),
        "execution", Object("schemaVersion", "UiScenarioExecutionEvidenceV1", "source", "ui_driver", "scenarioId", scenario["id"], "target", "windows_desktop", "steps", steps));
    }
    public static int Entry() {
      int exitCode = 2;
      var thread = new Thread(delegate() { exitCode = RunEntry(); });
      thread.SetApartmentState(ApartmentState.MTA); thread.Start(); thread.Join();
      return exitCode;
    }
    static int RunEntry() {
      using (var timer = new Timer(TerminateForDeadline, null, 10000, Timeout.Infinite)) {
        try {
          byte[] bytes;
          using (var input = Console.OpenStandardInput()) using (var buffer = new MemoryStream()) {
            var chunk = new byte[8192]; int count;
            while ((count = input.Read(chunk, 0, chunk.Length)) != 0) {
              if (buffer.Length + count > InputLimit) throw new ArgumentException("Input limit exceeded.");
              buffer.Write(chunk, 0, count);
            }
            bytes = buffer.ToArray();
          }
          var request = Map(Json.DeserializeObject(Utf8.GetString(bytes)));
          object result;
          object schema;
          if (request.TryGetValue("schemaVersion", out schema) && (string)schema == "WindowsUiObservationProbeRequestV1") {
            Keys(request, "schemaVersion", "");
            result = Object("schemaVersion", "WindowsUiObservationProbeResultV1", "features", new string[] { "uiAssertionObservation1" });
          }
          else if (request.TryGetValue("schemaVersion", out schema) && (string)schema == "WindowsSessionProbeRequestV1") result = ProbeSession(request);
          else if (request.TryGetValue("schemaVersion", out schema) && (string)schema == "WindowsTcpOwnerProbeRequestV1") result = ProbeTcp(request);
          else {
            Validate(request);
            // Only scenario execution needs a private per-monitor DPI context.
            IntPtr previous = Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (previous == IntPtr.Zero) throw new InvalidOperationException("DPI-aware capture is unavailable.");
            try {
              try { using (var driver = new Driver(request, timer)) result = driver.Run(); }
              catch (Failure failure) { result = StartupFailure(request, failure); }
            } finally { Native.SetThreadDpiAwarenessContext(previous); }
          }
          string output = Json.Serialize(result);
          if (Utf8.GetByteCount(output) > OutputLimit) throw new ArgumentException("Output limit exceeded.");
          Console.OutputEncoding = Utf8; Console.Out.WriteLine(output); Console.Out.Flush();
          return 0;
        } catch {
          Console.Error.WriteLine("Windows UI driver input or execution protocol failed."); return 2;
        }
      }
    }
  }
}
'@
    $references = @(
        [System.Windows.Automation.AutomationElement].Assembly.Location,
        [System.Windows.Automation.ControlType].Assembly.Location,
        [System.Windows.Rect].Assembly.Location,
        [System.Drawing.Bitmap].Assembly.Location,
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    )
    Add-Type -TypeDefinition $source -ReferencedAssemblies $references -Language CSharp
    exit [AgenticReview.WindowsUi.Driver]::Entry()
}
catch {
    [Console]::Error.WriteLine('Windows UI driver could not initialize its trusted runtime.')
    exit 2
}
