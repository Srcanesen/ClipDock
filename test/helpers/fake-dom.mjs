// Shared fake DOM extracted from the verifier's renderer fixtures.
// Keep each fixture's element inventory and API local to the test.
export function createFakeDom({ onFocus = () => {}, onReplaceChildren = () => {}, bounds = {} } = {}) {
  let activeElement = null;
  const makeElement = (tag = '', id = '') => {
    const tokens = new Set();
    const setClasses = (value) => { tokens.clear(); for (const token of String(value).split(/\s+/).filter(Boolean)) tokens.add(token); };
    return {
    id, tagName: tag.toUpperCase(), disabled: false, hidden: false, checked: false, textContent: '', value: '', src: '',
    alt: '', title: '', children: [], attributes: {}, dataset: {}, style: { values: {}, setProperty(name, value) { this.values[name] = String(value); } },
    get className() { return [...tokens].join(' '); },
    set className(value) { setClasses(value); this.attributes.class = this.className; },
    get options() { return this.children; },
    draggable: false, tabIndex: 0, listeners: {}, parentElement: null,
    get classList() {
      const element = this;
      const sync = () => { element.attributes.class = element.className; };
      return {
        get values() { return [...tokens]; },
        add(...values) { for (const value of values) tokens.add(value); sync(); },
        remove(...values) { for (const value of values) tokens.delete(value); sync(); },
        toggle(value, on = tokens.has(value) === false) { on ? tokens.add(value) : tokens.delete(value); sync(); return on; },
        contains(value) { return tokens.has(value); },
      };
    },
    handlers: {},
    addEventListener(type, callback) {
      const handlers = this.handlers[type] ??= new Set();
      handlers.add(callback);
      this.listeners[type] = (event = {}) => {
        for (const handler of [...handlers]) handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
      };
    },
    removeEventListener(type, callback) { this.handlers[type]?.delete(callback); },
    setAttribute(name, value) { if (name === 'class') this.className = value; else this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { if (name === 'class') tokens.clear(); delete this.attributes[name]; },
    append(...children) { for (const child of children) { if (child && typeof child === 'object') child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) { onReplaceChildren(this); this.children = []; this.append(...children); },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); },
    querySelector(selector) { return selector === 'button' ? this.children.find((child) => child.tagName === 'BUTTON') ?? null : null; },
    focus() { activeElement = this; onFocus(this); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 140, bottom: 79, width: 140, height: 79, ...bounds }; },
    click() { return this.listeners.click?.({ target: this, detail: 1, preventDefault() {}, stopPropagation() {} }); },
    };
  };
  return { makeElement, get activeElement() { return activeElement; } };
}
