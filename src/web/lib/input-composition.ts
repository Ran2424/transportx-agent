export function isComposingInput(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229;
}
