import { MultiSelectPrompt, SelectPrompt } from "@clack/core";

/**
 * Terminal pickers that show where the cursor is without color: a `›`
 * pointer, `[x]` boxes, and `(•)` radios. Color, when the terminal allows it
 * (no NO_COLOR, a TTY), only adds emphasis.
 */

export type Choice<T> = { value: T; label: string; hint?: string };

const useColor = () => process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0";
const paint = (code: number) => (text: string) => (useColor() ? `\u001b[${code}m${text}\u001b[0m` : text);
export const ui = {
  bold: paint(1),
  dim: paint(2),
  green: paint(32),
  cyan: paint(36),
  red: paint(31),
  inverse: paint(7),
};

const BAR = "│";
const ACTIVE = "◆";
const DONE = "◇";
const END = "└";

/** A row: pointer, mark, label, and the hint lined up after the longest label. */
function row(active: boolean, mark: string, label: string, width: number, hint?: string): string {
  const pointer = active ? ui.cyan("›") : " ";
  const text = active ? ui.bold(label.padEnd(width)) : label.padEnd(width);
  return `${ui.dim(BAR)}  ${pointer} ${mark} ${text}${hint ? `  ${ui.dim(hint)}` : ""}`;
}

function header(state: string, message: string): string {
  const symbol = state === "submit" ? ui.green(DONE) : state === "cancel" ? ui.red(DONE) : state === "error" ? ui.red(ACTIVE) : ui.cyan(ACTIVE);
  return `${ui.dim(BAR)}\n${symbol}  ${message}\n`;
}

/** Pick any number of choices. Resolves to the chosen values, or undefined when cancelled. */
export async function chooseMany<T>(message: string, choices: Choice<T>[], options: { initial?: T[]; required?: string } = {}): Promise<T[] | undefined> {
  const width = Math.max(...choices.map((choice) => choice.label.length));
  const prompt = new MultiSelectPrompt<Choice<T>>({
    options: choices,
    initialValues: options.initial ?? [],
    required: options.required !== undefined,
    validate: (value) => (options.required && (!value || value.length === 0) ? options.required : undefined),
    render() {
      const picked = (this.value ?? []) as T[];
      const title = header(this.state, message);
      if (this.state === "submit") {
        const names = choices.filter((choice) => picked.includes(choice.value)).map((choice) => choice.label);
        return `${title}${ui.dim(BAR)}  ${ui.dim(names.join(", ") || "none")}`;
      }
      if (this.state === "cancel") return `${title}${ui.dim(BAR)}  ${ui.dim("cancelled")}`;
      const rows = choices.map((choice, index) => {
        const on = picked.includes(choice.value);
        return row(index === this.cursor, on ? ui.green("[x]") : "[ ]", choice.label, width, choice.hint);
      });
      const footer =
        this.state === "error"
          ? `${ui.red(BAR)}  ${ui.red(this.error)}`
          : `${ui.dim(BAR)}  ${ui.dim("↑/↓ move · space toggle · a all · enter confirm")}`;
      return `${title}${rows.join("\n")}\n${footer}\n${ui.dim(END)}`;
    },
  });
  const result = await prompt.prompt();
  return typeof result === "symbol" ? undefined : (result as T[]);
}

/** Pick one choice. Resolves to its value, or undefined when cancelled. */
export async function chooseOne<T>(message: string, choices: Choice<T>[], initial?: T): Promise<T | undefined> {
  const width = Math.max(...choices.map((choice) => choice.label.length));
  const prompt = new SelectPrompt<Choice<T>>({
    options: choices,
    initialValue: initial,
    render() {
      const title = header(this.state, message);
      const current = choices[this.cursor];
      if (this.state === "submit") return `${title}${ui.dim(BAR)}  ${ui.dim(current?.label ?? "")}`;
      if (this.state === "cancel") return `${title}${ui.dim(BAR)}  ${ui.dim("cancelled")}`;
      const rows = choices.map((choice, index) =>
        row(index === this.cursor, index === this.cursor ? ui.green("(•)") : "( )", choice.label, width, choice.hint),
      );
      return `${title}${rows.join("\n")}\n${ui.dim(BAR)}  ${ui.dim("↑/↓ move · enter confirm")}\n${ui.dim(END)}`;
    },
  });
  const result = await prompt.prompt();
  return typeof result === "symbol" ? undefined : (result as T);
}
