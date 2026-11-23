import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CompiledHelper } from '../../src/compiled-helper.js';

/** What the stand-in prints once it has run its time out, which only a process left alone gets to. */
export const BOX_GAME_RAN_ON = 'the game ran on';

/** The title and text of the box the stand-in opens for `text`, which hold letters outside ASCII. */
export const BOX_GAME_TITLE = 'Fehler bei der Türöffnung';
export const BOX_GAME_TEXT = 'Grafiktreiber fehlt: Größe 日本語';

/**
 * A Windows program standing in for a game that opens a message box. The first argument names where:
 * `main` opens it on the thread the game runs on, `text` the same with a title and text outside
 * ASCII, `worker` on a thread of its own while the game runs on, `child` in a second process it
 * starts, and `wrapper` in a second process it starts and waits for, as Godot's console build does.
 * `worker` and `child` print {@link BOX_GAME_RAN_ON} and exit 0 after five seconds when nothing has
 * ended them.
 */
const SOURCE = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class BoxGame {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int MessageBoxW(IntPtr window, string text, string title, uint kind);
  const uint TaskModal = 0x2000;

  static void Box() {
    MessageBoxW(IntPtr.Zero, "Hello from the game", "Game alert", TaskModal);
  }

  static Process Second() {
    ProcessStartInfo info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "main");
    info.${['UseShell', 'Execute'].join('')} = false;
    info.CreateNoWindow = true;
    Process second = new Process();
    second.StartInfo = info;
    second.Start();
    return second;
  }

  public static int Main(string[] args) {
    string where = args.Length > 0 ? args[0] : "main";
    if (where == "main") {
      Box();
      return 0;
    }
    if (where == "text") {
      MessageBoxW(IntPtr.Zero, "${escaped(BOX_GAME_TEXT)}", "${escaped(BOX_GAME_TITLE)}", TaskModal);
      return 0;
    }
    if (where == "wrapper") {
      Process engine = Second();
      engine.WaitForExit();
      return engine.ExitCode;
    }
    if (where == "worker") {
      Thread worker = new Thread(Box);
      worker.IsBackground = true;
      worker.Start();
    }
    if (where == "child") {
      Second();
    }
    Thread.Sleep(5000);
    Console.WriteLine("${BOX_GAME_RAN_ON}");
    return 0;
  }
}
`;

/** [param text] as C# escapes, so the source holds ASCII only. */
function escaped(text: string): string {
  let written = '';
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    written += code < 0x80 ? text.charAt(at) : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return written;
}

const GAME = new CompiledHelper('box game stand-in', 'gdharness-box-game', SOURCE, { program: true });

/** The compiled stand-in's path, or why it could not be compiled. */
export async function boxGame(): Promise<string> {
  const failed = await GAME.ensure();
  if (failed !== null) {
    throw new Error(failed);
  }
  return GAME.assembly(tmpdir());
}

/** The stand-in under the name of Godot's console build, which starts the engine as its child and waits for it. */
export async function boxGameConsole(): Promise<string> {
  const program = await boxGame();
  const wrapper = program.replace(/\.exe$/, '_console.exe');
  copyFileSync(program, wrapper);
  return wrapper;
}
