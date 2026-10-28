import {
  isRegisteredCommandEnabled,
  runRegisteredCommand,
  type AppCommand,
} from "@/lib/commands";
import {
  getCurrentKeyboardCommandScope,
  type KeyboardCommandScope,
} from "@/lib/keyboardShortcuts";
import {
  isTextEditingCommandEnabled,
  runTextEditingCommand,
  type TextEditingCommand,
} from "@/lib/textEditingCommands";

type EditCommand = TextEditingCommand | "undo" | "redo";

const FILE_COMMAND_IDS: Record<TextEditingCommand, string> = {
  cut: "file.cut",
  copy: "file.copy",
  paste: "file.paste",
  "select-all": "file.select-all",
};

function getEditableCommandScope(): KeyboardCommandScope | "text" | null {
  const scope = getCurrentKeyboardCommandScope();
  if (scope) return scope;

  const activeElement = typeof document === "undefined" ? null : document.activeElement;
  if (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLElement && activeElement.isContentEditable)
  ) {
    return "text";
  }
  return null;
}

function isEditCommandEnabled(command: EditCommand): boolean {
  const scope = getEditableCommandScope();
  if (scope === "file-view" && command in FILE_COMMAND_IDS) {
    return isRegisteredCommandEnabled(FILE_COMMAND_IDS[command as TextEditingCommand]);
  }
  if (scope === "text" && command !== "undo" && command !== "redo") {
    return isTextEditingCommandEnabled(command);
  }
  return false;
}

function runEditCommand(command: EditCommand): void | Promise<void> {
  const scope = getEditableCommandScope();
  if (scope === "file-view" && command in FILE_COMMAND_IDS) {
    runRegisteredCommand(FILE_COMMAND_IDS[command as TextEditingCommand]);
    return;
  }
  if (scope === "text" && command !== "undo" && command !== "redo") {
    return runTextEditingCommand(command);
  }
}

function makeCommand(command: TextEditingCommand, shortcut: string): AppCommand<void> {
  return {
    id: `edit.${command}`,
    shortcut,
    enabled: () => isEditCommandEnabled(command),
    run: () => runEditCommand(command),
  };
}

export const editCommands: AppCommand<void>[] = [
  makeCommand("cut", "⌘X"),
  makeCommand("copy", "⌘C"),
  makeCommand("paste", "⌘V"),
  makeCommand("select-all", "⌘A"),
];
