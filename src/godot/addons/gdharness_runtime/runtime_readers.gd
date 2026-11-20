extends RefCounted
## The clients that ask a system's own screen-reader interface for what the game tells it, one per
## system: a C# client compiled once by the .NET Framework's compiler for UI Automation on Windows,
## python3 with libatspi for AT-SPI on Linux and osascript's JavaScript for the AX API on macOS.
##
## Every client takes the same first arguments (the answer's path, the progress path, the settle and
## empty budgets in ms and the deepest level), marks the stages [code]began[/code],
## [code]loaded[/code]
## and [code]walked N[/code] with the Unix time in ms in the progress file, and writes one JSON
## answer
## of the same shape: [code]{"windows": [tree, ...]}[/code] or [code]{"error": text}[/code].
## Each element holds its role in UI Automation's words, its name, bounds in the window's pixels,
## the actions and states a screen reader is offered, and its children.

## How long compiling the Windows client may take before the compiler is stopped.
const COMPILE_MS: int = 60000
## The prefix of the compiled client's files, so a stale one is told from any other file.
const CLIENT_PREFIX: String = "gdharness-reader-"
const _FRAMEWORK_COMPILER: String = "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
## The Windows client, C# for the compiler the .NET Framework ships, which speaks C# 5. Its
## arguments are the answer's path, the progress path, the settle and empty budgets, the deepest
## level and the game's native window handles. Each element answers what UI Automation names its
## role, its name, its value where it has one, its bounds in the window's pixels, and the actions a
## screen reader is offered on it.
const UIA_CLIENT: String = r"""
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

static class GdhReader
{
    static string progress;
    static int mostLevels;
    static string unread;
    static MethodInfo ask;
    static FieldInfo nodeField;

    static void Mark(string stage)
    {
        File.AppendAllText(progress, stage + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "\n");
    }

    static string Quote(string text)
    {
        if (text == null) { return "\"\""; }
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"') { b.Append("\\\""); }
            else if (c == '\\') { b.Append("\\\\"); }
            else if (c < ' ') { b.Append("\\u").Append(((int)c).ToString("x4")); }
            else { b.Append(c); }
        }
        return b.Append('"').ToString();
    }

    static string Number(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) { return "0"; }
        return d.ToString("R", CultureInfo.InvariantCulture);
    }

    static string Whole(double d)
    {
        return ((int)Math.Round(d)).ToString(CultureInfo.InvariantCulture);
    }

    static string Bool(bool b)
    {
        return b ? "true" : "false";
    }

    // One element's fields in the order they are set, a field set again keeping its place.
    class Node
    {
        public List<string> Keys = new List<string>();
        public Dictionary<string, string> Values = new Dictionary<string, string>();
        public string Children = "[]";
        public int Count = 1;

        public void Set(string key, string json)
        {
            if (!Values.ContainsKey(key)) { Keys.Add(key); }
            Values[key] = json;
        }

        public string Json()
        {
            StringBuilder b = new StringBuilder("{");
            foreach (string key in Keys) { b.Append(Quote(key)).Append(':').Append(Values[key]).Append(','); }
            return b.Append("\"children\":").Append(Children).Append('}').ToString();
        }
    }

    static object Patterned(AutomationElement element, AutomationPattern pattern)
    {
        object found;
        return element.TryGetCurrentPattern(pattern, out found) ? found : null;
    }

    // FullDescription is where the description is put, and the managed client refuses every property
    // newer than itself, so it is asked through the core call the client makes for the rest.
    static string FullDescription(AutomationElement element)
    {
        if (unread != null) { return ""; }
        try
        {
            object[] asked = new object[] { nodeField.GetValue(element), 30159, null };
            ask.Invoke(null, asked);
            string said = asked[2] as string;
            if (said != null) { return said; }
        }
        catch (Exception e)
        {
            unread = e.ToString();
        }
        return "";
    }

    static Node Describe(AutomationElement element, double ox, double oy, int depth)
    {
        AutomationElement.AutomationElementInformation c = element.Current;
        string role = Regex.Replace(c.ControlType.ProgrammaticName, "^ControlType[.]", "");
        role = Regex.Replace(role, "(?<=[a-z])(?=[A-Z])", "_").ToLowerInvariant();
        Node node = new Node();
        node.Set("role", Quote(role));
        node.Set("name", Quote(c.Name));
        string description = FullDescription(element);
        if (description.Length > 0) { node.Set("description", Quote(description)); }
        if (!string.IsNullOrEmpty(c.HelpText)) { node.Set("placeholder", Quote(c.HelpText)); }
        // The element's own id, the last four parts of its runtime id, which the game reads back as the
        // node that made it.
        int[] runtime = element.GetRuntimeId();
        if (runtime != null && runtime.Length >= 4)
        {
            int n = runtime.Length;
            node.Set("element_id", "[" + runtime[n - 4] + "," + runtime[n - 3] + "," + runtime[n - 2] + "," + runtime[n - 1] + "]");
        }
        System.Windows.Rect r = c.BoundingRectangle;
        if (!r.IsEmpty)
        {
            node.Set("bounds", "{\"x\":" + Whole(r.X - ox) + ",\"y\":" + Whole(r.Y - oy) + ",\"width\":" + Whole(r.Width) + ",\"height\":" + Whole(r.Height) + "}");
        }
        List<string> actions = new List<string>();
        object p;
        if (Patterned(element, InvokePattern.Pattern) != null) { actions.Add("click"); }
        p = Patterned(element, TogglePattern.Pattern);
        if (p != null)
        {
            actions.Add("toggle");
            node.Set("toggled", Quote(((TogglePattern)p).Current.ToggleState.ToString().ToLowerInvariant()));
        }
        p = Patterned(element, ExpandCollapsePattern.Pattern);
        if (p != null)
        {
            actions.Add("expand_collapse");
            node.Set("expanded", Quote(((ExpandCollapsePattern)p).Current.ExpandCollapseState.ToString().ToLowerInvariant()));
        }
        p = Patterned(element, SelectionItemPattern.Pattern);
        if (p != null)
        {
            actions.Add("select");
            node.Set("selected", Bool(((SelectionItemPattern)p).Current.IsSelected));
        }
        string said = "";
        p = Patterned(element, ValuePattern.Pattern);
        if (p != null)
        {
            said = ((ValuePattern)p).Current.Value ?? "";
            node.Set("value", Quote(said));
            if (!((ValuePattern)p).Current.IsReadOnly) { actions.Add("set_value"); }
        }
        p = Patterned(element, RangeValuePattern.Pattern);
        if (p != null)
        {
            RangeValuePattern.RangeValuePatternInformation range = ((RangeValuePattern)p).Current;
            // A reader speaks the Value pattern's words, such as "75%" for a slider whose game sets them,
            // and the number would otherwise replace them.
            if (said.Length > 0) { node.Set("value_text", Quote(said)); }
            node.Set("value", Number(range.Value));
            node.Set("range", "[" + Number(range.Minimum) + "," + Number(range.Maximum) + "]");
            if (!range.IsReadOnly) { actions.Add("set_value"); }
        }
        if (Patterned(element, ScrollItemPattern.Pattern) != null) { actions.Add("scroll_into_view"); }
        if (c.IsKeyboardFocusable) { actions.Add("focus"); }
        List<string> quoted = new List<string>();
        foreach (string action in actions) { quoted.Add(Quote(action)); }
        node.Set("actions", "[" + string.Join(",", quoted.ToArray()) + "]");
        if (c.HasKeyboardFocus) { node.Set("focused", "true"); }
        if (!c.IsEnabled) { node.Set("disabled", "true"); }
        if (c.IsOffscreen) { node.Set("offscreen", "true"); }
        if (depth < mostLevels)
        {
            List<string> children = new List<string>();
            AutomationElement child = TreeWalker.RawViewWalker.GetFirstChild(element);
            while (child != null)
            {
                Node inner = Describe(child, ox, oy, depth + 1);
                node.Count += inner.Count;
                children.Add(inner.Json());
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
            node.Children = "[" + string.Join(",", children.ToArray()) + "]";
        }
        return node;
    }

    static void Answer(string path, string json)
    {
        Mark("answering");
        File.WriteAllText(path, json, new UTF8Encoding(false));
        Mark("answered");
    }

    // Arguments: the answer's path, the progress path, the settle and empty budgets in ms, the deepest
    // level, then the native window handles.
    static int Main(string[] args)
    {
        string path = args[0];
        progress = args[1];
        try
        {
            int settleMs = int.Parse(args[2], CultureInfo.InvariantCulture);
            int emptyMs = int.Parse(args[3], CultureInfo.InvariantCulture);
            mostLevels = int.Parse(args[4], CultureInfo.InvariantCulture);
            Mark("began");
            try
            {
                Type client = typeof(AutomationElement);
                Type core = client.Assembly.GetType("MS.Internal.Automation.UiaCoreApi");
                ask = core.GetMethod("UiaGetPropertyValue", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static);
                nodeField = client.GetField("_hnode", BindingFlags.NonPublic | BindingFlags.Instance);
                if (ask == null || nodeField == null) { unread = "this Windows has no UiaGetPropertyValue to ask it through"; }
            }
            catch (Exception e)
            {
                unread = e.ToString();
            }
            Mark("loaded");
            List<string> windows = new List<string>();
            for (int at = 5; at < args.Length; at++)
            {
                AutomationElement root = AutomationElement.FromHandle(new IntPtr(long.Parse(args[at], CultureInfo.InvariantCulture)));
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(settleMs);
                DateTime empty = DateTime.UtcNow.AddMilliseconds(emptyMs);
                // The window's corner is read on every walk: before the engine builds its tree the window is
                // its frame, and after it the client area inside it, so a corner read once placed everything
                // by the frame's.
                System.Windows.Rect r = root.Current.BoundingRectangle;
                Node tree = Describe(root, r.X, r.Y, 0);
                int last = tree.Count;
                Mark("walked " + last);
                // Walked again until two walks in a row agree, since the first question is what makes the
                // engine build the tree, which arrives over the frames after it.
                while (DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(150);
                    r = root.Current.BoundingRectangle;
                    tree = Describe(root, r.X, r.Y, 0);
                    int count = tree.Count;
                    Mark("walked " + count);
                    if (count > 1 && count == last) { break; }
                    if (count == 1 && DateTime.UtcNow > empty) { break; }
                    last = count;
                }
                windows.Add(tree.Json());
            }
            string answer = "{\"windows\":[" + string.Join(",", windows.ToArray()) + "]";
            if (unread != null) { answer += ",\"description_unread\":" + Quote(unread); }
            Answer(path, answer + "}");
        }
        catch (Exception e)
        {
            Answer(path, "{\"error\":" + Quote(e.ToString()) + "}");
        }
        return 0;
    }
}
"""
## The Linux client, Python for libatspi's introspection. Its arguments follow the shared ones with
## the game's process id and the number of windows it has. Roles are put into UI Automation's words
## and an element's id is read from the last part of its object path.
const ATSPI_CLIENT: String = r"""
import json
import os
import sys
import time

out, progress = sys.argv[1], sys.argv[2]
settle_ms, empty_ms, most_levels, game_pid, wanted = [int(a) for a in sys.argv[3:8]]
NEEDS = (
    'python3 with the gi module and the Atspi 2.0 typelib (Debian and Ubuntu: python3-gi '
    'gir1.2-atspi-2.0) and an accessibility bus (at-spi2-core)'
)
ROLES = {
    'frame': 'window', 'window': 'window', 'dialog': 'window', 'file-chooser': 'window',
    'alert': 'window', 'panel': 'group', 'section': 'group', 'filler': 'group',
    'landmark': 'group', 'form': 'group', 'label': 'text', 'static': 'text',
    'caption': 'text', 'heading': 'text', 'paragraph': 'text', 'push-button': 'button',
    'toggle-button': 'button', 'check-box': 'check_box', 'radio-button': 'radio_button',
    'slider': 'slider', 'scroll-bar': 'scroll_bar', 'spin-button': 'spinner',
    'entry': 'edit', 'text': 'edit', 'password-text': 'edit', 'combo-box': 'combo_box',
    'list': 'list', 'list-box': 'list', 'list-item': 'list_item', 'menu': 'menu',
    'menu-bar': 'menu_bar', 'menu-item': 'menu_item', 'check-menu-item': 'menu_item',
    'radio-menu-item': 'menu_item', 'page-tab': 'tab_item', 'page-tab-list': 'tab',
    'progress-bar': 'progress_bar', 'level-bar': 'progress_bar', 'table': 'table',
    'table-cell': 'data_item', 'tool-bar': 'tool_bar', 'tool-tip': 'tool_tip', 'tree': 'tree',
    'tree-item': 'tree_item', 'tree-table': 'tree', 'separator': 'separator',
    'image': 'image', 'link': 'hyper_link', 'document-frame': 'document', 'canvas': 'custom',
    'status-bar': 'status_bar', 'title-bar': 'title_bar',
}


def now():
    return int(time.time() * 1000)


def mark(stage):
    with open(progress, 'a') as marks:
        marks.write('%s %d\n' % (stage, now()))


def answer(value):
    mark('answering')
    with open(out, 'w') as written:
        json.dump(value, written)
    mark('answered')


def refuse(message):
    answer({'error': message})
    sys.exit(0)


mark('began')
try:
    import gi

    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi, Gio, GLib
except Exception as failure:
    refuse('python3 cannot load AT-SPI (%s). It needs %s.' % (failure, NEEDS))
# The engine builds its tree for AT-SPI only once the session bus says a screen reader may be
# running, which a desktop with no screen reader leaves false, so it is set here as Orca does.
try:
    session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    session.call_sync(
        'org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
        GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))),
        None, Gio.DBusCallFlags.NONE, 5000, None,
    )
except Exception as failure:
    refuse('no accessibility bus answers (%s). It needs %s.' % (failure, NEEDS))
Atspi.init()
context = GLib.MainContext.default()
mark('loaded')

State = Atspi.StateType


def settle_events():
    while context.pending():
        context.iteration(False)


def game_windows():
    # The registry lists an application once the engine has built its tree for AT-SPI, which
    # follows the setting above within a few frames.
    settle_events()
    desktop = Atspi.get_desktop(0)
    desktop.clear_cache()
    for at in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(at)
        if app is not None and app.get_process_id() == game_pid:
            app.clear_cache()
            return [app.get_child_at_index(n) for n in range(min(app.get_child_count(), wanted))]
    return []


def element_id(accessible):
    # The last part of the object's path holds AccessKit's id, the engine's element, in the
    # high half of a 128-bit number, or alone in older AccessKit, so both halves are offered.
    path = getattr(accessible, 'path', None)
    if not path:
        return None
    try:
        number = int(str(path).rsplit('/', 1)[-1])
    except ValueError:
        return None
    low, high = number & 0xFFFFFFFFFFFFFFFF, number >> 64
    return [low >> 32, low & 0xFFFFFFFF, high >> 32, high & 0xFFFFFFFF]


def describe(accessible, depth):
    accessible.clear_cache()
    nick = accessible.get_role().value_nick
    states = accessible.get_state_set()
    node = {'role': ROLES.get(nick, nick.replace('-', '_')), 'name': accessible.get_name() or ''}
    said = accessible.get_description()
    if said:
        node['description'] = said
    identity = element_id(accessible)
    if identity is not None:
        node['element_id'] = identity
    component = accessible.get_component_iface()
    if component is not None:
        box = component.get_extents(Atspi.CoordType.WINDOW)
        if box.width > 0 and box.height > 0:
            node['bounds'] = {'x': box.x, 'y': box.y, 'width': box.width, 'height': box.height}
    actions = []
    action = accessible.get_action_iface()
    if action is not None:
        for at in range(action.get_n_actions()):
            if action.get_action_name(at) == 'click':
                actions.append('click')
    if states.contains(State.CHECKABLE) or nick == 'toggle-button':
        actions.append('toggle')
        if states.contains(State.INDETERMINATE):
            node['toggled'] = 'indeterminate'
        else:
            on = states.contains(State.CHECKED) or states.contains(State.PRESSED)
            node['toggled'] = 'on' if on else 'off'
    if states.contains(State.EXPANDABLE):
        actions.append('expand_collapse')
        node['expanded'] = 'expanded' if states.contains(State.EXPANDED) else 'collapsed'
    if states.contains(State.SELECTABLE):
        actions.append('select')
        node['selected'] = states.contains(State.SELECTED)
    if nick in ('entry', 'text', 'password-text'):
        text = accessible.get_text_iface()
        if text is not None:
            node['value'] = text.get_text(0, -1)
        if states.contains(State.EDITABLE):
            actions.append('set_value')
    value = accessible.get_value_iface()
    if value is not None:
        words = None
        try:
            words = value.get_text()
        except Exception:
            pass
        if words:
            node['value_text'] = words
        node['value'] = value.get_current_value()
        node['range'] = [value.get_minimum_value(), value.get_maximum_value()]
        actions.append('set_value')
    if states.contains(State.FOCUSABLE):
        actions.append('focus')
    node['actions'] = actions
    if states.contains(State.FOCUSED):
        node['focused'] = True
    if not states.contains(State.ENABLED) and not states.contains(State.SENSITIVE):
        node['disabled'] = True
    if not states.contains(State.SHOWING):
        node['offscreen'] = True
    node['children'] = []
    if depth < most_levels:
        for at in range(accessible.get_child_count()):
            child = accessible.get_child_at_index(at)
            if child is not None:
                node['children'].append(describe(child, depth + 1))
    return node


def count(node):
    return 1 + sum(count(child) for child in node['children'])


try:
    windows = []
    given = time.time() + settle_ms / 1000.0
    found = game_windows()
    while not found and time.time() < given:
        time.sleep(0.15)
        found = game_windows()
    for window in found:
        deadline = time.time() + settle_ms / 1000.0
        empty = time.time() + empty_ms / 1000.0
        tree = describe(window, 0)
        last = count(tree)
        mark('walked %d' % last)
        # Walked again until two walks in a row agree, since the first question is what makes
        # the engine build the tree, which arrives over the frames after it.
        while time.time() < deadline:
            time.sleep(0.15)
            settle_events()
            tree = describe(window, 0)
            total = count(tree)
            mark('walked %d' % total)
            if total > 1 and total == last:
                break
            if total == 1 and time.time() > empty:
                break
            last = total
        windows.append(tree)
    answer({'windows': windows})
except Exception as failure:
    answer({'error': '%s: %s' % (type(failure).__name__, failure)})
"""
## The macOS client, JavaScript for Automation over the ObjC bridge to the AX API. Its arguments
## follow the shared ones with the game's process id and the number of windows it has.
const AX_CLIENT: String = r"""
ObjC.import('ApplicationServices');
ObjC.import('Foundation');

const ROLES = {
  AXWindow: 'window', AXSheet: 'window', AXDialog: 'window', AXGroup: 'group',
  AXSplitGroup: 'group', AXScrollArea: 'group', AXStaticText: 'text', AXButton: 'button',
  AXCheckBox: 'check_box', AXRadioButton: 'radio_button', AXSlider: 'slider',
  AXScrollBar: 'scroll_bar', AXTextField: 'edit', AXTextArea: 'edit', AXComboBox: 'combo_box',
  AXPopUpButton: 'combo_box', AXList: 'list', AXMenu: 'menu', AXMenuBar: 'menu_bar',
  AXMenuItem: 'menu_item', AXTabGroup: 'tab', AXProgressIndicator: 'progress_bar',
  AXTable: 'table', AXToolbar: 'tool_bar', AXImage: 'image', AXLink: 'hyper_link',
  AXOutline: 'tree', AXCell: 'data_item', AXHeading: 'text',
};

function run(argv) {
  const out = argv[0];
  const progressPath = argv[1];
  const settleMs = parseInt(argv[2], 10);
  const emptyMs = parseInt(argv[3], 10);
  const mostLevels = parseInt(argv[4], 10);
  const gamePid = parseInt(argv[5], 10);
  const wanted = parseInt(argv[6], 10);
  let marks = '';
  const write = (path, text) => {
    $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  };
  const mark = (stage) => {
    marks += stage + ' ' + Date.now() + '\n';
    write(progressPath, marks);
  };
  const answer = (value) => {
    mark('answering');
    write(out, JSON.stringify(value));
    mark('answered');
  };
  mark('began');
  if (!$.AXIsProcessTrusted()) {
    answer({ error: 'Accessibility is not allowed for this process', permission: true });
    return;
  }
  const raw = (element, name) => {
    const ref = Ref();
    return $.AXUIElementCopyAttributeValue(element, $(name), ref) === 0 ? ref[0] : null;
  };
  const text = (element, name) => {
    const value = raw(element, name);
    return value === null ? '' : String(ObjC.unwrap(value));
  };
  // Positions and sizes arrive as AXValue structs the bridge does not unpack, so they are read
  // from the value's description: {value = x:10.000000 y:20.000000 type = kAXValueCGPointType}.
  const pair = (element, name, first, second) => {
    const value = raw(element, name);
    if (value === null) {
      return null;
    }
    const said = ObjC.unwrap($.CFCopyDescription(value));
    const found = new RegExp(first + ':(-?[0-9.]+) ' + second + ':(-?[0-9.]+)').exec(said);
    return found === null ? null : [parseFloat(found[1]), parseFloat(found[2])];
  };
  const kids = (element) => {
    const value = raw(element, 'AXChildren');
    return value === null ? [] : ObjC.unwrap(value);
  };
  const snake = (word) => word.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const describe = (element, origin, depth) => {
    const kind = text(element, 'AXRole');
    const node = { role: ROLES[kind] || snake(kind) };
    let name = text(element, 'AXTitle') || text(element, 'AXDescription');
    const value = raw(element, 'AXValue');
    if (!name && kind === 'AXStaticText' && value !== null) {
      name = String(ObjC.unwrap(value));
    }
    node.name = name;
    const help = text(element, 'AXHelp');
    if (help) {
      node.description = help;
    }
    const at = pair(element, 'AXPosition', 'x', 'y');
    const size = pair(element, 'AXSize', 'w', 'h');
    if (at !== null && size !== null && size[0] > 0 && size[1] > 0) {
      node.bounds = {
        x: Math.round(at[0] - origin[0]),
        y: Math.round(at[1] - origin[1]),
        width: Math.round(size[0]),
        height: Math.round(size[1]),
      };
    }
    const actions = [];
    const names = Ref();
    if ($.AXUIElementCopyActionNames(element, names) === 0) {
      const listed = ObjC.unwrap(names[0]).map((one) => String(ObjC.unwrap(one)));
      if (listed.indexOf('AXPress') >= 0) {
        actions.push('click');
      }
    }
    if (value !== null && kind !== 'AXStaticText') {
      const unwrapped = ObjC.unwrap(value);
      if (typeof unwrapped === 'number') {
        node.value = unwrapped;
        const low = raw(element, 'AXMinValue');
        const high = raw(element, 'AXMaxValue');
        if (low !== null && high !== null) {
          node.range = [Number(ObjC.unwrap(low)), Number(ObjC.unwrap(high))];
        }
        actions.push('set_value');
      } else {
        node.value = String(unwrapped);
      }
    }
    const focused = raw(element, 'AXFocused');
    if (focused !== null) {
      actions.push('focus');
      if (ObjC.unwrap(focused) === true) {
        node.focused = true;
      }
    }
    node.actions = actions;
    const enabled = raw(element, 'AXEnabled');
    if (enabled !== null && ObjC.unwrap(enabled) === false) {
      node.disabled = true;
    }
    node.children = [];
    if (depth < mostLevels) {
      for (const child of kids(element)) {
        node.children.push(describe(child, origin, depth + 1));
      }
    }
    return node;
  };
  const count = (node) => node.children.reduce((total, child) => total + count(child), 1);
  const application = $.AXUIElementCreateApplication(gamePid);
  mark('loaded');
  const sleep = (seconds) => $.NSThread.sleepForTimeInterval(seconds);
  const windowsOf = () => {
    const listed = raw(application, 'AXWindows');
    return listed === null ? [] : ObjC.unwrap(listed).slice(0, wanted);
  };
  const windows = [];
  let found = windowsOf();
  const given = Date.now() + settleMs;
  while (found.length === 0 && Date.now() < given) {
    sleep(0.15);
    found = windowsOf();
  }
  for (const window of found) {
    const deadline = Date.now() + settleMs;
    const empty = Date.now() + emptyMs;
    const walk = () => describe(window, pair(window, 'AXPosition', 'x', 'y') || [0, 0], 0);
    let tree = walk();
    let last = count(tree);
    mark('walked ' + last);
    // Walked again until two walks in a row agree, since the first question is what makes the
    // engine build the tree, which arrives over the frames after it.
    while (Date.now() < deadline) {
      sleep(0.15);
      tree = walk();
      const total = count(tree);
      mark('walked ' + total);
      if (total > 1 && total === last) {
        break;
      }
      if (total === 1 && Date.now() > empty) {
        break;
      }
      last = total;
    }
    windows.push(tree);
  }
  answer({ windows: windows });
}
"""

var _host: Node


func _init(host: Node) -> void:
	_host = host


## What the running system's reader is: [code]system[/code] the interface it asks,
## [code]starter[/code]
## the program that runs the client, [code]needs[/code] what must be there for it to run, and
## [code]element_ids[/code] whether its elements say which node made them. Empty where there is
## none.
static func profile() -> Dictionary:
	match OS.get_name():
		"Windows":
			return {
				"system": "UI Automation",
				"starter": "The compiled client",
				"needs": "the .NET Framework's csc.exe under the Windows folder, in Microsoft.NET",
				"element_ids": true,
			}
		"Linux":
			return {
				"system": "AT-SPI",
				"starter": "The python3 process",
				"needs":
				(
					"python3 with the gi module and the Atspi 2.0 typelib (Debian and Ubuntu: "
					+ "python3-gi gir1.2-atspi-2.0), and an accessibility bus (at-spi2-core)"
				),
				"element_ids": true,
			}
		"macOS":
			return {
				"system": "the AX API",
				"starter": "The osascript process",
				"needs":
				(
					"Accessibility allowed for the app that runs the game: open System Settings, "
					+ "Privacy & Security, Accessibility, and switch on Godot or the terminal "
					+ "that started it"
				),
				"element_ids": false,
			}
	return {}


## The folder the Windows client is compiled into: the user's cache, so the next game on this
## machine finds it.
static func cache_dir() -> String:
	return OS.get_cache_dir().path_join("gdharness").path_join("readers")


## Where the Windows compiler is.
static func compiler() -> String:
	return OS.get_environment("SystemRoot").path_join(_FRAMEWORK_COMPILER)


## Starts this system's client on the game's [param handles] (native window handles, used on
## Windows only) with [param limits]: the settle and empty budgets in ms and the deepest level.
## Answers [code]pid[/code], [code]started_ms[/code] and [code]compile_ms[/code], or
## [code]error[/code] saying what could not be started.
func start(
	out: String, progress: String, handles: Array[String], limits: Array[int]
) -> Dictionary:
	var args: PackedStringArray = PackedStringArray([out, progress])
	for limit: int in limits:
		var _added: bool = args.append(str(limit))
	var program: String = ""
	var compile_ms: int = 0
	match OS.get_name():
		"Windows":
			var built: Dictionary = await compile_client(cache_dir(), UIA_CLIENT, compiler())
			if built.has("error"):
				return built
			program = built["exe"]
			compile_ms = built["compile_ms"]
			args.append_array(PackedStringArray(handles))
		"Linux":
			program = "python3"
			args = PackedStringArray(["-c", ATSPI_CLIENT]) + args
			args.append_array(PackedStringArray([str(OS.get_process_id()), str(handles.size())]))
		"macOS":
			program = "/usr/bin/osascript"
			args = PackedStringArray(["-l", "JavaScript", "-e", AX_CLIENT]) + args
			args.append_array(PackedStringArray([str(OS.get_process_id()), str(handles.size())]))
		_:
			return { "error": "There is no screen-reader client for %s" % OS.get_name() }
	var started_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	var pid: int = OS.create_process(program, args)
	if pid <= 0:
		return { "error": "%s could not be started to read the tree" % program }
	return { "pid": pid, "started_ms": started_ms, "compile_ms": compile_ms }


## The compiled Windows client for [param source] in [param dir], compiled with [param csc] when it
## is not there yet. The file's name carries a hash of the source and the references, so a changed
## client is compiled again and an unchanged one never is. Answers [code]exe[/code] and
## [code]compile_ms[/code] (0 when it was found), or [code]error[/code] naming what failed.
func compile_client(dir: String, source: String, csc: String) -> Dictionary:
	var wpf: String = csc.get_base_dir().path_join("WPF")
	var references: PackedStringArray = []
	for library: String in ["UIAutomationClient", "UIAutomationTypes", "WindowsBase"]:
		var _referenced: bool = references.append(
			"/r:" + wpf.path_join(library + ".dll").replace("/", "\\")
		)
	var key: String = ("\n".join(references) + "\n" + source).sha256_text().left(16)
	var exe: String = dir.path_join("%s%s.exe" % [CLIENT_PREFIX, key])
	if FileAccess.file_exists(exe):
		return { "exe": exe, "compile_ms": 0 }
	if not FileAccess.file_exists(csc):
		return {
			"error":
			(
				"The reader cannot be compiled: %s is missing. It is the C# compiler the .NET "
				+ "Framework 4 ships with Windows."
			)
			% csc,
		}
	if DirAccess.make_dir_recursive_absolute(dir) != OK:
		return { "error": "The reader cannot be compiled: %s cannot be made" % dir }
	var code: String = exe.trim_suffix(".exe") + ".cs"
	var file: FileAccess = FileAccess.open(code, FileAccess.WRITE)
	if file == null:
		return { "error": "The reader cannot be compiled: %s cannot be written" % code }
	var _stored: bool = file.store_string(source)
	file.close()
	var built: String = exe.trim_suffix(".exe") + "-%d.tmp" % OS.get_process_id()
	var args: PackedStringArray = PackedStringArray(
		["/nologo", "/optimize+", "/target:exe", "/out:" + built.replace("/", "\\")]
	)
	args.append_array(references)
	var _sourced: bool = args.append(code.replace("/", "\\"))
	var began: int = Time.get_ticks_msec()
	var pid: int = OS.create_process(csc, args)
	if pid <= 0:
		return { "error": "The reader cannot be compiled: %s could not be started" % csc }
	while OS.is_process_running(pid):
		if Time.get_ticks_msec() - began > COMPILE_MS:
			var _killed: Error = OS.kill(pid)
			return {
				"error": "The reader's compiler %s took over %d ms and was stopped" % [
					csc,
					COMPILE_MS,
				],
			}
		await _host.get_tree().process_frame
	if not FileAccess.file_exists(built):
		# The compiler's complaint is only on its output, which a started process does not give
		# back. A compile that failed fails the same way again, and quickly, so it is run once
		# more to read it.
		var output: Array = []
		var _exit: int = OS.execute(csc, args, output, true, false)
		var said: String = ""
		for part: String in output:
			said += part
		said = said.strip_edges()
		return { "error": "The reader cannot be compiled: %s said %s" % [csc, said.left(800)] }
	if DirAccess.rename_absolute(built, exe) != OK:
		# Another game compiled the same client at the same time, and its file is the one kept.
		var _lost: Error = DirAccess.remove_absolute(built)
		if not FileAccess.file_exists(exe):
			return { "error": "The reader compiled by %s cannot be put at %s" % [csc, exe] }
	_prune(dir, exe.get_file().trim_suffix(".exe"))
	return { "exe": exe, "compile_ms": Time.get_ticks_msec() - began }


## Removes the compiled clients and sources of other versions from [param dir], keeping those
## starting with [param keep].
static func _prune(dir: String, keep: String) -> void:
	for file_name: String in DirAccess.get_files_at(dir):
		if file_name.begins_with(CLIENT_PREFIX) and not file_name.begins_with(keep):
			# Not checked: a client another game is running cannot be removed, and is left.
			var _removed: Error = DirAccess.remove_absolute(dir.path_join(file_name))
