using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace AgenticReview.WindowsUi {
  // HashSet does not promise enumeration order. This adapter deliberately exercises the
  // production algorithm with the reverse order while retaining ordinary set semantics.
  public sealed class HashSet<T> : ICollection<T> {
    readonly System.Collections.Generic.HashSet<T> values = new System.Collections.Generic.HashSet<T>();
    public int Count { get { return values.Count; } }
    public bool IsReadOnly { get { return false; } }
    public bool Add(T value) { return values.Add(value); }
    void ICollection<T>.Add(T value) { Add(value); }
    public bool Remove(T value) { return values.Remove(value); }
    public bool Contains(T value) { return values.Contains(value); }
    public void Clear() { values.Clear(); }
    public bool IsSupersetOf(IEnumerable<T> other) { return values.IsSupersetOf(other); }
    public bool SetEquals(IEnumerable<T> other) { return values.SetEquals(other); }
    public IEnumerator<T> GetEnumerator() {
      return (World.Current.ReverseEnumeration ? values.Reverse() : values).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
    public void CopyTo(T[] array, int offset) { foreach (T value in this) array[offset++] = value; }
  }

  public sealed class Failure : Exception {
    public readonly string Code;
    public Failure(string code, string outcome, string message) : base(message) { Code = code; }
  }

  public sealed class ProcessState {
    public uint Id, Session = 7;
    public ulong Created;
    public bool IsAlive = true, CanOpen = true, HasSession = true;
    public int Opens;
    public Func<bool> ReadAlive;
    public ProcessState(uint id, ulong created) { Id = id; Created = created; }
  }

  public sealed class OwnedProcess : IDisposable {
    public readonly uint Id, ParentId;
    public readonly ulong Created;
    readonly ProcessState state;
    public OwnedProcess(uint id, uint parentId) : this(id, parentId, World.Current.Open(id)) { }
    public OwnedProcess(uint id, uint parentId, ProcessState value) {
      Id = id; ParentId = parentId; Created = value.Created; state = value;
    }
    public bool Alive { get { return state.ReadAlive == null ? state.IsAlive : state.ReadAlive(); } }
    public void Dispose() { }
  }

  public sealed class World {
    public static World Current;
    public readonly Dictionary<uint, ProcessState> States = new Dictionary<uint, ProcessState>();
    public readonly Dictionary<uint, uint> First = new Dictionary<uint, uint>();
    public readonly Dictionary<uint, uint> Second = new Dictionary<uint, uint>();
    public readonly Dictionary<uint, OwnedProcess> Held = new Dictionary<uint, OwnedProcess>();
    public bool ReverseEnumeration;
    public int Snapshots, TcpTables;
    public Action<int> BeforeSnapshot, BeforeTcpTable;
    public Action<uint> AfterSession;
    public readonly List<uint> Listeners = new List<uint>();
    public uint WindowOwner = 1, WindowThread = 42;
    public OwnedProcess Root;
    public World() {
      Current = this;
      Add(1, 0, 100);
      Root = Hold(1, 0);
    }
    public ProcessState Add(uint id, uint parent, ulong created = 0) {
      var state = new ProcessState(id, created == 0 ? 100 + id : created);
      States.Add(id, state); First.Add(id, parent); Second.Add(id, parent); return state;
    }
    public OwnedProcess Hold(uint id, uint parent) {
      var value = new OwnedProcess(id, parent, States[id]); Held.Add(id, value); return value;
    }
    public ProcessState Open(uint id) {
      ProcessState state;
      if (!States.TryGetValue(id, out state)) throw Driver.OwnershipFailure();
      state.Opens++;
      if (!state.CanOpen) throw Driver.OwnershipFailure();
      return state;
    }
    public Dictionary<uint, uint> Snapshot() {
      Snapshots++; if (BeforeSnapshot != null) BeforeSnapshot(Snapshots);
      return new Dictionary<uint, uint>(Snapshots % 2 == 1 ? First : Second);
    }
  }

  public static class Native {
    public static bool ProcessIdToSessionId(uint id, out uint session) {
      ProcessState state;
      if (!World.Current.States.TryGetValue(id, out state)) { session = 7; return true; }
      session = state.Session;
      if (World.Current.AfterSession != null) World.Current.AfterSession(id);
      return state.HasSession;
    }
    public static uint GetWindowThreadProcessId(IntPtr window, out uint process) {
      process = World.Current.WindowOwner; return World.Current.WindowThread;
    }
    public static bool IsWindow(IntPtr window) { return window != IntPtr.Zero; }
  }

  public sealed class Driver {
    readonly Dictionary<uint, OwnedProcess> owned;
    HashSet<uint> live = new HashSet<uint>();
    readonly OwnedProcess root;
    readonly uint session = 7;
    IntPtr readyWindow;
    uint readyProcess, readyThread;
    Driver(World world) { owned = world.Held; root = world.Root; }
    void Interactive() { }
    static Dictionary<uint, uint> SnapshotParents() { return World.Current.Snapshot(); }
    static List<uint> TcpListeners(int port) {
      var world = World.Current;
      world.TcpTables++; if (world.BeforeTcpTable != null) world.BeforeTcpTable(world.TcpTables);
      return new List<uint>(world.Listeners);
    }
    static void Keys(Dictionary<string, object> value, string required, string optional) { }
    static Dictionary<string, object> Map(object value) { return (Dictionary<string, object>)value; }
    static decimal Number(object value, decimal minimum, decimal maximum) { return Convert.ToDecimal(value); }
    static string Text(object value, int minimum, int maximum, bool empty) { return (string)value; }
    static Dictionary<string, object> Object(params object[] pairs) {
      var result = new Dictionary<string, object>();
      for (int index = 0; index < pairs.Length; index += 2) result.Add((string)pairs[index], pairs[index + 1]);
      return result;
    }

    // __PRODUCTION_OWNERSHIP_METHODS__

    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void EqualSet(HashSet<uint> actual, params uint[] expected) {
      Check(actual.SetEquals(expected), "Unexpected eligible process set: " + String.Join(",", actual));
    }
    static void Reject(Action action) {
      try { action(); } catch (Failure error) {
        Check(error.Code == "ownership_lost", "Unexpected failure code."); return;
      }
      throw new Exception("Expected ownership_lost.");
    }
    static HashSet<uint> Refresh(World world, uint owner = 1) {
      return RefreshOwnedProcesses(world.Held, world.Root, 7, owner);
    }
    static World Chain(bool held = false) {
      var world = new World(); world.Add(2, 1, 200); world.Add(3, 2, 300);
      if (held) { world.Hold(2, 1); world.Hold(3, 2); }
      return world;
    }
    static string TcpReason(World world, string created = "100") {
      var input = Object("schemaVersion", "WindowsTcpOwnerProbeRequestV1",
        "rootProcess", Object("pid", 1, "creationTimeFileTime", created), "port", 3286);
      return (string)Map(ProbeTcp(input))["reasonCode"];
    }
    static Driver Pinned(World world, uint owner) {
      return new Driver(world) { readyWindow = new IntPtr(1), readyThread = 42, readyProcess = owner };
    }

    public static int Main() {
      var cases = new List<KeyValuePair<string, Action>> {
        new KeyValuePair<string, Action>("transient sibling and descendants are excluded", delegate {
          var world = Chain(); world.Add(4, 1, 400);
          world.BeforeSnapshot = delegate(int index) { if (index == 2) world.States[2].IsAlive = false; };
          EqualSet(Refresh(world), 1, 4);
          Check(world.Held.Count == 4, "Successfully held retired identities must remain retained.");
        }),
        new KeyValuePair<string, Action>("unopenable parent cannot lend ancestry", delegate {
          var world = Chain(); world.States[2].CanOpen = false; world.Add(4, 1, 400);
          EqualSet(Refresh(world), 1, 4);
          Check(world.States[3].Opens == 0, "A child of an unproven parent must not be opened.");
        }),
        new KeyValuePair<string, Action>("second snapshot edge mismatch excludes the subtree", delegate {
          var world = Chain(); world.Second[2] = 99;
          EqualSet(Refresh(world), 1);
        }),
        new KeyValuePair<string, Action>("first snapshot cannot replace a held parent edge", delegate {
          var world = Chain(true); world.First[3] = 1; world.Second[3] = 1;
          EqualSet(Refresh(world), 1, 2);
          Check(world.Held[3].ParentId == 2 && world.States[3].Opens == 0, "Held parent identity changed.");
        }),
        new KeyValuePair<string, Action>("session and creation mismatches remain ineligible", delegate {
          var world = new World(); world.Add(2, 1, 200).Session = 8;
          world.Add(3, 1, 50); world.Add(4, 1, 400); world.Add(5, 2, 500);
          world.Add(6, 1, 600).HasSession = false;
          EqualSet(Refresh(world), 1, 4);
          Check(world.States[5].Opens == 0, "A session-mismatched parent lent its ancestry.");
        }),
        new KeyValuePair<string, Action>("retired PID identities are never reopened", delegate {
          var world = new World(); var retired = world.Add(2, 1, 200); world.Hold(2, 1);
          retired.IsAlive = false;
          var replacement = new ProcessState(2, 500); world.States[2] = replacement;
          EqualSet(Refresh(world), 1);
          Check(replacement.Opens == 0 && world.Held[2].Created == 200, "A retired PID was reopened or replaced.");
        }),
        new KeyValuePair<string, Action>("retired identities retain the 128 process budget", delegate {
          var world = new World();
          for (uint id = 2; id <= 128; id++) { world.Add(id, 1).IsAlive = false; world.Hold(id, 1); }
          world.Add(129, 1);
          Reject(delegate { Refresh(world); });
          Check(world.Held.Count == 128 && world.States[129].Opens == 0, "The identity budget was reclaimed or exceeded.");
        }),
        new KeyValuePair<string, Action>("missing required owner never falls back to root", delegate {
          var world = new World(); Reject(delegate { Refresh(world, 99); });
          Check(world.Snapshots == 0, "A missing pinned owner reached discovery.");
        }),
        new KeyValuePair<string, Action>("missing held ancestor is rejected", delegate {
          var world = Chain(true); world.Held.Remove(2);
          Reject(delegate { Refresh(world, 3); });
          Check(world.Snapshots == 0, "A missing held ancestor reached discovery.");
        }),
        new KeyValuePair<string, Action>("cyclic required ancestry is rejected", delegate {
          var world = new World(); world.Add(2, 3, 200); world.Add(3, 2, 200);
          world.Hold(2, 3); world.Hold(3, 2);
          Reject(delegate { Refresh(world, 3); });
        }),
        new KeyValuePair<string, Action>("required creation inversion is rejected", delegate {
          var world = new World(); world.Add(2, 1, 200); world.Add(3, 2, 150);
          world.Hold(2, 1); world.Hold(3, 2);
          Reject(delegate { Refresh(world, 3); });
        }),
        new KeyValuePair<string, Action>("required owner death is rejected", delegate {
          var world = Chain(true);
          world.BeforeSnapshot = delegate(int index) { if (index == 2) world.States[3].IsAlive = false; };
          Reject(delegate { Refresh(world, 3); });
        }),
        new KeyValuePair<string, Action>("required ancestor death is rejected", delegate {
          var world = Chain(true);
          world.BeforeSnapshot = delegate(int index) { if (index == 2) world.States[2].IsAlive = false; };
          Reject(delegate { Refresh(world, 3); });
        }),
        new KeyValuePair<string, Action>("missing or foreign-session root is rejected", delegate {
          var world = new World(); world.Second.Remove(1); Reject(delegate { Refresh(world); });
          world = new World(); world.States[1].Session = 8; Reject(delegate { Refresh(world); });
        }),
        new KeyValuePair<string, Action>("root dictionary identity cannot be replaced", delegate {
          var world = new World(); world.Held[1] = new OwnedProcess(1, 0, new ProcessState(1, 100));
          Reject(delegate { Refresh(world); });
        }),
        new KeyValuePair<string, Action>("reverse-order pruning converges after an admitted parent dies", delegate {
          var world = Chain(); world.ReverseEnumeration = true;
          bool childConfirmed = false, scheduledExit = false; int parentReads = 0;
          world.AfterSession = delegate(uint id) {
            if (world.Snapshots == 2 && id == 3) childConfirmed = true;
          };
          world.States[2].ReadAlive = delegate {
            // The first parent read after the child's session query finishes admission.
            // During pruning, the child is visited before its parent. Return the last live
            // observation, then retire the parent before the parent's own pruning visit.
            if (childConfirmed && ++parentReads == 2) {
              scheduledExit = true; world.States[2].IsAlive = false; return true;
            }
            return world.States[2].IsAlive;
          };
          EqualSet(Refresh(world), 1);
          Check(scheduledExit, "The deterministic post-confirmation exit did not occur.");
        }),
        new KeyValuePair<string, Action>("stable descendant TCP listener is owned", delegate {
          var world = Chain(); world.Listeners.Add(3);
          Check(TcpReason(world) == "owned", "A stable descendant listener was rejected.");
          Check(world.TcpTables == 2, "The TCP listener was not independently confirmed.");
        }),
        new KeyValuePair<string, Action>("TCP ancestor death during final table read is rejected", delegate {
          var world = Chain(); world.Listeners.Add(3);
          world.BeforeTcpTable = delegate(int index) { if (index == 2) world.States[2].IsAlive = false; };
          Check(TcpReason(world) == "ownership_lost", "An orphaned listener was accepted.");
          Check(world.States[3].IsAlive && world.States[1].IsAlive, "Only the listener's ancestor should exit.");
        }),
        new KeyValuePair<string, Action>("TCP root creation mismatch remains rejected", delegate {
          var world = Chain(); world.Listeners.Add(3);
          Check(TcpReason(world, "101") == "ownership_lost", "The root FILETIME mismatch was accepted.");
        }),
        new KeyValuePair<string, Action>("partial or missing window pins are rejected", delegate {
          var world = new World(); var driver = Pinned(world, 0);
          Reject(delegate { driver.RefreshOwnership(); });
          driver = Pinned(world, 99); Reject(delegate { driver.RefreshOwnership(); });
        }),
        new KeyValuePair<string, Action>("window action rechecks the held ancestor chain", delegate {
          var world = Chain(true); var driver = Pinned(world, 3); driver.RefreshOwnership();
          world.WindowOwner = 3; world.States[2].IsAlive = false;
          Reject(delegate { driver.OwnedWindow(new IntPtr(1)); });
        }),
        new KeyValuePair<string, Action>("failed refresh does not publish a partial live set", delegate {
          var world = Chain(true); var driver = Pinned(world, 3); driver.RefreshOwnership();
          var previous = driver.live;
          world.BeforeSnapshot = delegate(int index) { if (index == 4) world.States[2].IsAlive = false; };
          Reject(delegate { driver.RefreshOwnership(); });
          Check(System.Object.ReferenceEquals(previous, driver.live), "A failed refresh replaced the live set.");
          EqualSet(previous, 1, 2, 3);
        })
      };
      var results = new List<object>(); bool failed = false;
      foreach (var test in cases) {
        try { test.Value(); results.Add(new { name = test.Key, passed = true, error = (string)null }); }
        catch (Exception error) { failed = true; results.Add(new { name = test.Key, passed = false, error = error.ToString() }); }
      }
      Console.WriteLine(JsonSerializer.Serialize(new { cases = results }));
      return failed ? 1 : 0;
    }
  }
}
