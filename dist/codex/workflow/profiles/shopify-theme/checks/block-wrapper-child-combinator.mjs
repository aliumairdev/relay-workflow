// L3: the platform wraps every block in an element, so direct-child (>) selectors on block containers miss the blocks.
export const id = 'block-wrapper-child-combinator';
export const description = 'Direct-child combinator on a block/slide/column container (blocks are wrapped by the platform)';
export const globs = ['**/*.css', '**/*.liquid', '**/*.js'];
const CONTAINER = '[\\w.#\\[\\]="-]*(?:blocks?|slides?|columns?|carousel|grid|items?|cards?)[\\w\\]="-]*';

export function check(text, file = '') {
  const out = [];
  const css = /\.css$/.test(file) || /<style|\{%-?\s*style/.test(text);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (css || /^[^'"]*[.#\[][\w-]+[^{]*\{/.test(line)) {
      const re = new RegExp(`${CONTAINER}\\s*>\\s*[*.\\w\\[]`, 'i');
      if (re.test(line.split('{')[0]) && !/\/\*.*>.*\*\//.test(line)) out.push({ line: i + 1, message: 'child combinator ">" on a block container: the platform wraps each block, so target [data-block] or a descendant instead' });
    }
    if (/\.js$/.test(file) && /(?:blocks?|slides?|carousel)[\w]*\.children\b|:scope\s*>/i.test(line)) out.push({ line: i + 1, message: 'iterating direct children of a block container: wrappers break this; query [data-block] descendants' });
  });
  return out;
}
