const EDITABLE_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="textbox"]';
const OVERLAY_TARGET_SELECTOR =
  '[aria-modal="true"], [role="menu"], [role="listbox"], [data-context-menu-content], [data-radix-menu-content]';
const QUICK_LOOK_SCOPE_SELECTOR = '[data-keyboard-scope="quick-look"]';

export type KeyboardCommandScope = "file-view" | "preview";

export interface KeyboardCommand {
  id: string;
  scope: KeyboardCommandScope;
  priority?: number;
  matches: (event: KeyboardEvent) => boolean;
  enabled?: () => boolean;
  run: (event: KeyboardEvent) => void | Promise<void>;
}

interface KeyboardCommandRegistration {
  token: symbol;
  order: number;
  command: KeyboardCommand;
}

const registrations = new Map<symbol, KeyboardCommandRegistration>();
let nextRegistrationOrder = 0;
let listenerInstalled = false;

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(EDITABLE_TARGET_SELECTOR));
}

function isVisibleOverlay(element: Element): boolean {
  if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function scopeForElements(candidates: Element[]): KeyboardCommandScope | null {
  if (candidates.some(isEditableTarget)) return null;

  const activeOverlay = [...document.querySelectorAll(OVERLAY_TARGET_SELECTOR)]
    .reverse()
    .find(isVisibleOverlay);
  if (activeOverlay) {
    return activeOverlay.closest(QUICK_LOOK_SCOPE_SELECTOR) ? "preview" : null;
  }

  const scopedTarget = candidates.find((element) => element.closest(QUICK_LOOK_SCOPE_SELECTOR));
  if (scopedTarget) return "preview";

  return "file-view";
}

function scopeForEvent(event: KeyboardEvent): KeyboardCommandScope | null {
  const eventTarget = event.target instanceof Element ? event.target : null;
  const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
  const candidates = [eventTarget, activeElement].filter((element): element is Element => Boolean(element));
  return scopeForElements(candidates);
}

export function getCurrentKeyboardCommandScope(): KeyboardCommandScope | null {
  const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
  return scopeForElements(activeElement ? [activeElement] : []);
}

function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

function dispatchKeyboardCommand(event: KeyboardEvent): void {
  if (event.defaultPrevented || isComposing(event)) return;

  const scope = scopeForEvent(event);
  if (!scope) return;

  const ordered = [...registrations.values()].sort((left, right) => {
    const priority = (right.command.priority ?? 0) - (left.command.priority ?? 0);
    return priority || left.order - right.order;
  });

  for (const { command } of ordered) {
    if (command.scope !== scope || command.enabled?.() === false || !command.matches(event)) {
      continue;
    }

    event.preventDefault();
    const result = command.run(event);
    if (result && typeof result.then === "function") {
      void result.catch((error: unknown) => {
        console.error(`Keyboard command '${command.id}' failed:`, error);
      });
    }
    return;
  }
}

function installListener(): void {
  if (listenerInstalled || typeof window === "undefined") return;
  window.addEventListener("keydown", dispatchKeyboardCommand);
  listenerInstalled = true;
}

export function registerKeyboardCommands(commands: KeyboardCommand[]): () => void {
  installListener();
  const tokens = commands.map((command) => {
    const token = Symbol(command.id);
    registrations.set(token, { token, order: nextRegistrationOrder++, command });
    return token;
  });

  return () => {
    for (const token of tokens) registrations.delete(token);
    if (registrations.size === 0 && listenerInstalled && typeof window !== "undefined") {
      window.removeEventListener("keydown", dispatchKeyboardCommand);
      listenerInstalled = false;
    }
  };
}

export function shouldIgnoreKeyboardCommand(
  event: KeyboardEvent,
  options: { allowOverlaySelector?: string } = {}
): boolean {
  if (isComposing(event)) return true;
  const eventTarget = event.target instanceof Element ? event.target : null;
  const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
  const candidates = [eventTarget, activeElement].filter((element): element is Element => Boolean(element));

  if (candidates.some(isEditableTarget)) return true;

  const overlay = candidates
    .map((element) => element.closest(OVERLAY_TARGET_SELECTOR))
    .find((element): element is Element => Boolean(element));
  const activeOverlay = [...document.querySelectorAll(OVERLAY_TARGET_SELECTOR)]
    .reverse()
    .find(isVisibleOverlay);
  const currentOverlay = activeOverlay || overlay;
  if (!currentOverlay) return false;

  return !options.allowOverlaySelector || !currentOverlay.closest(options.allowOverlaySelector);
}

export function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('button, a[href], video[controls], audio[controls], [role="button"]'))
  );
}
