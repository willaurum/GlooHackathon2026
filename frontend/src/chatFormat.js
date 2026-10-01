// Assistant replies may use a small Markdown subset: **bold**, *italic*, headings, and
// "-", "*", "•" or "1." lists. It is parsed into plain data so the widget renders React
// elements, never raw HTML.

const listItem = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;
const heading = /^\s*#{1,6}\s+(.*)$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const emphasis = /\*\*(.+?)\*\*|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

export function inline(text) {
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(emphasis)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    segments.push(match[1] !== undefined ? { text: match[1], bold: true } : { text: match[2], italic: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

export function formatReply(text) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', segments: inline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const item = line.match(listItem);
    const title = line.match(heading);
    if (!line.trim() || rule.test(line)) {
      flush();
    } else if (item && !rule.test(line)) {
      flush();
      const type = item[2] ? 'ol' : 'ul', previous = blocks.at(-1);
      const list = previous?.type === type ? previous : (blocks.push({ type, items: [] }), blocks.at(-1));
      list.items.push(inline(item[3].trim()));
    } else if (title) {
      flush();
      blocks.push({ type: 'p', segments: [{ text: title[1].replace(/\*\*/g, ''), bold: true }] });
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}
