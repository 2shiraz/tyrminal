// Command boundaries from shell integration (OSC 133, "FinalTerm" marks): when the shell reports
// where each prompt starts and how each command ended, a thin separator is drawn above every
// prompt after the first, with a small mark in the gutter for a command that failed, and the user
// can jump between commands. Display and scrolling only; without the marks nothing changes.
//
//   OSC 133 ; A ST  prompt starts        OSC 133 ; C ST  command output starts
//   OSC 133 ; B ST  command line starts  OSC 133 ; D [; exit] ST  command finished

import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

const MAX_MARKS = 2000;

interface Mark {
  prompt: IMarker;
  separator: IDecoration | undefined;
  status?: IDecoration | undefined;
}

export class CommandMarks {
  private marks: Mark[] = [];
  private readonly disposables: IDisposable[] = [];
  /** The prompt of the command that is running (between C and D). */
  private running: Mark | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly colors: () => { failure: string; text: string },
  ) {
    this.disposables.push(term.parser.registerOscHandler(133, (data) => this.onMark(data)));
  }

  get count(): number {
    return this.marks.length;
  }

  private onMark(data: string): boolean {
    // Marks on the alternate screen (full-screen applications) are ignored.
    if (this.term.buffer.active.type === "alternate") return true;
    const [kind, ...args] = data.split(";");
    if (kind === "A") this.promptStart();
    else if (kind === "C") this.running = this.marks.at(-1) ?? null;
    else if (kind === "D") this.finished(args[0]);
    // Handled: the sequence is never printed and nothing else acts on it.
    return true;
  }

  private promptStart(): void {
    const prompt = this.term.registerMarker(0);
    if (!prompt) return;
    // Two marks on one line (a prompt redrawn in place) count once.
    const last = this.marks.at(-1);
    if (last && last.prompt.line === prompt.line) {
      prompt.dispose();
      return;
    }
    const separator =
      this.marks.length === 0
        ? undefined
        : this.term.registerDecoration({ marker: prompt, x: 0, width: this.term.cols, height: 1, layer: "bottom" });
    separator?.onRender((element) => {
      element.classList.add("cmd-separator");
      // A hairline in the scheme's own text color, faint enough not to compete with output.
      element.style.setProperty("--cmd-line", this.colors().text);
    });
    const mark: Mark = { prompt, separator };
    prompt.onDispose(() => {
      this.marks = this.marks.filter((m) => m !== mark);
    });
    this.marks.push(mark);
    while (this.marks.length > MAX_MARKS) this.dispose1(this.marks[0] as Mark);
  }

  private finished(exit: string | undefined): void {
    const mark = this.running;
    this.running = null;
    const code = exit === undefined || exit === "" ? null : Number(exit);
    if (!mark || mark.prompt.isDisposed || code === null || !Number.isFinite(code) || code === 0) return;
    // A failed command: a short bar in the gutter of its prompt line.
    const status = this.term.registerDecoration({ marker: mark.prompt, x: 0, width: 1, height: 1, layer: "top", overviewRulerOptions: { color: this.colors().failure } });
    status?.onRender((element) => {
      element.classList.add("cmd-failed");
      element.style.setProperty("--cmd-failed", this.colors().failure);
      element.title = `Exit status ${code}`;
    });
    mark.status = status;
  }

  private dispose1(mark: Mark): void {
    mark.status?.dispose();
    mark.separator?.dispose();
    mark.prompt.dispose();
  }

  /** Scrolls to the previous (-1) or next (+1) command's prompt; false when there is none. */
  jump(direction: -1 | 1): boolean {
    const buffer = this.term.buffer.active;
    // At the bottom the reference is the cursor (the command line being typed), so "previous"
    // is the last command run; scrolled up, it is the top of the screen.
    const atBottom = buffer.viewportY >= buffer.baseY;
    const from = atBottom && direction < 0 ? buffer.baseY + buffer.cursorY : buffer.viewportY;
    const lines = this.marks.map((m) => m.prompt.line).filter((line) => line >= 0);
    const target = direction < 0 ? lines.filter((l) => l < from).at(-1) : lines.find((l) => l > from);
    if (target === undefined) return false;
    this.term.scrollToLine(target);
    return true;
  }

  dispose(): void {
    for (const mark of [...this.marks]) this.dispose1(mark);
    this.marks = [];
    for (const d of this.disposables) d.dispose();
  }
}
