export interface AppCommand<Payload = void> {
  id: string;
  shortcut?: string;
  enabled?: (payload: Payload) => boolean;
  run: (payload: Payload) => void | Promise<void>;
}

interface RegisteredCommand {
  token: symbol;
  command: AppCommand<never>;
}

const registeredCommands = new Map<symbol, RegisteredCommand>();

function notifyCommandRegistryChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("app-command-registry-changed"));
  }
}

export function isCommandEnabled<Payload>(command: AppCommand<Payload>, payload?: Payload): boolean {
  return command.enabled?.(payload as Payload) ?? true;
}

export function runCommand<Payload>(command: AppCommand<Payload>, payload?: Payload): boolean {
  if (!isCommandEnabled(command, payload)) return false;

  try {
    const result = command.run(payload as Payload);
    if (result && typeof result.then === "function") {
      void result.catch((error: unknown) => {
        console.error(`Command '${command.id}' failed:`, error);
      });
    }
    return true;
  } catch (error) {
    console.error(`Command '${command.id}' failed:`, error);
    return false;
  }
}

export function registerAppCommands(commands: readonly AppCommand<never>[]): () => void {
  const tokens = commands.map((command) => {
    const token = Symbol(command.id);
    registeredCommands.set(token, { token, command });
    return token;
  });
  notifyCommandRegistryChanged();

  return () => {
    for (const token of tokens) registeredCommands.delete(token);
    notifyCommandRegistryChanged();
  };
}

function getRegisteredCommand(id: string): AppCommand<never> | undefined {
  return [...registeredCommands.values()].reverse().find(({ command }) => command.id === id)?.command;
}

export function isRegisteredCommandEnabled(id: string, payload?: unknown): boolean {
  const command = getRegisteredCommand(id);
  return command ? isCommandEnabled(command, payload as never) : false;
}

export function runRegisteredCommand(id: string, payload?: unknown): boolean {
  const command = getRegisteredCommand(id);
  return command ? runCommand(command, payload as never) : false;
}
