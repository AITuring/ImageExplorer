export type TextEditingCommand = "cut" | "copy" | "paste" | "select-all";

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set([
  "email",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

function getEditableElement(): EditableElement | null {
  if (typeof document === "undefined") return null;
  const activeElement = document.activeElement;

  if (activeElement instanceof HTMLTextAreaElement) return activeElement;
  if (activeElement instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(activeElement.type) ? activeElement : null;
  }
  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return activeElement;
  }
  return null;
}

function isInputElement(element: EditableElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function getSelectedText(element: EditableElement): string | null {
  if (isInputElement(element)) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null) return null;
    if (start === end) return "";
    return element.value.slice(start, end);
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return "";
  return element.contains(selection.anchorNode) ? selection.toString() : "";
}

function hasEditableText(element: EditableElement): boolean {
  return isInputElement(element) ? element.value.length > 0 : Boolean(element.textContent?.length);
}

function canEdit(element: EditableElement): boolean {
  if (isInputElement(element)) return !element.disabled && !element.readOnly;
  return !element.hasAttribute("disabled") && element.getAttribute("contenteditable") !== "false";
}

function hasSystemClipboard(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.clipboard);
}

export function isTextEditingCommandEnabled(command: TextEditingCommand): boolean {
  const element = getEditableElement();
  if (!element) return false;

  switch (command) {
    case "cut":
      return (
        canEdit(element) &&
        (getSelectedText(element) === null
          ? document.queryCommandEnabled("cut")
          : hasSystemClipboard() && Boolean(getSelectedText(element)))
      );
    case "copy": {
      const selectedText = getSelectedText(element);
      return selectedText === null
        ? document.queryCommandEnabled("copy")
        : hasSystemClipboard() && Boolean(selectedText);
    }
    case "paste":
      return hasSystemClipboard() && canEdit(element);
    case "select-all":
      return hasEditableText(element);
  }
}

function dispatchInput(element: HTMLElement, inputType: string, data: string | null): void {
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType,
      data,
    })
  );
}

function replaceInputSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  insertedText: string,
  inputType: string
): void {
  const value = element.value;
  const start = element.selectionStart ?? value.length;
  const end = element.selectionEnd ?? start;
  const nextValue = `${value.slice(0, start)}${insertedText}${value.slice(end)}`;
  const valueDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  valueDescriptor?.set?.call(element, nextValue);
  const caret = start + insertedText.length;
  element.setSelectionRange(caret, caret);
  dispatchInput(element, inputType, insertedText || null);
}

function replaceContentEditableSelection(element: HTMLElement, insertedText: string): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range || !element.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }

  range.deleteContents();
  if (insertedText) {
    const textNode = document.createTextNode(insertedText);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchInput(element, insertedText ? "insertFromPaste" : "deleteByCut", insertedText || null);
  return true;
}

export async function runTextEditingCommand(command: TextEditingCommand): Promise<void> {
  const element = getEditableElement();
  if (!element || !isTextEditingCommandEnabled(command)) return;

  switch (command) {
    case "copy":
    case "cut": {
      const selectedText = getSelectedText(element);
      if (selectedText === null) {
        document.execCommand(command);
        return;
      }
      await navigator.clipboard.writeText(selectedText);
      if (command === "cut" && getEditableElement() === element) {
        if (isInputElement(element)) replaceInputSelection(element, "", "deleteByCut");
        else replaceContentEditableSelection(element, "");
      }
      return;
    }
    case "paste": {
      const text = await navigator.clipboard.readText();
      if (getEditableElement() !== element) return;
      if (isInputElement(element)) {
        if (element.selectionStart === null || element.selectionEnd === null) {
          document.execCommand("insertText", false, text);
        } else {
          replaceInputSelection(element, text, "insertFromPaste");
        }
      } else replaceContentEditableSelection(element, text);
      return;
    }
    case "select-all":
      element.focus();
      if (isInputElement(element)) {
        element.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
  }
}
