export function usesLocalBasemapName(textField: unknown) {
  return JSON.stringify(textField)?.includes('"name:nonlatin"') === true;
}
