/**
 * Event targets are not always elements: a text node, the window, or (in a
 * test) a plain object can arrive. These helpers ask the duck-typed question
 * the handlers mean, "is this inside an element matching X", without relying
 * on a global `Element` class that differs between frames and test DOMs.
 */

/** The nearest element at or above `target` matching `selector`, or null. */
export function closestElement<T extends Element = HTMLElement>(target: EventTarget | null, selector: string): T | null {
  const element = target as Partial<Element> | null;
  return typeof element?.closest === "function" ? element.closest<T>(selector) : null;
}
