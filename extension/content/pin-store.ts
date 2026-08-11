/** Live pin Element map + pick mode (shared by picker / panel). */

export type PickMode = "off" | "one" | "keep";

const pinElements = new Map<string, Element>();

let pickMode: PickMode = "off";
let picking = false;

export function getPinElement(id: string): Element | undefined {
  return pinElements.get(id);
}

export function setPinElement(id: string, el: Element): void {
  pinElements.set(id, el);
}

export function clearPinElements(id?: string): void {
  if (id) pinElements.delete(id);
  else pinElements.clear();
}

export function getPickMode(): PickMode {
  return pickMode;
}

export function setPickMode(mode: PickMode): void {
  pickMode = mode === "keep" || mode === "one" || mode === "off" ? mode : "off";
}

export function isPicking(): boolean {
  return picking;
}

export function setPicking(active: boolean): void {
  picking = active;
}
