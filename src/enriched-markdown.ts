/** Markdown through Software Mansion's Enriched Markdown engine: the md4c parser it ships
 * for the web (vendored WebAssembly, see src/vendor/enriched-markdown), rendered to HTML
 * with the node set its web renderer supports. Math renders through KaTeX on demand. */

type NodeType =
  | 'Document' | 'Paragraph' | 'Text' | 'Link' | 'Heading' | 'LineBreak' | 'SoftBreak' | 'Strong' | 'Emphasis'
  | 'Strikethrough' | 'Underline' | 'Superscript' | 'Subscript' | 'Highlight' | 'Code' | 'Image' | 'Blockquote'
  | 'UnorderedList' | 'OrderedList' | 'ListItem' | 'CodeBlock' | 'ThematicBreak' | 'Table' | 'TableHead' | 'TableBody'
  | 'TableRow' | 'TableHeaderCell' | 'TableCell' | 'LatexMathInline' | 'LatexMathDisplay' | 'BlankLine' | 'Admonition' | 'Video';
export interface MarkdownNode {
  type: NodeType;
  content?: string;
  attributes?: { level?: string; url?: string; title?: string; language?: string; isTask?: string; taskChecked?: string; admonitionType?: string; align?: string; start?: string; tight?: string };
  children?: MarkdownNode[];
}
export interface RenderOptions {
  /** Rewrites a link target before it is written, e.g. file: URLs into workspace paths. */
  link?: (url: string) => string;
}

type Parse = (markdown: string, ...flags: number[]) => string;
let parser: Promise<Parse> | undefined;
function load(): Promise<Parse> {
  parser ??= import('./vendor/enriched-markdown/md4c.js')
    .then(module => module.default())
    .then((wasm: { cwrap: (name: string, returns: string, args: string[]) => Parse }) =>
      wasm.cwrap('parseMarkdown', 'string', ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']))
    .catch(error => { parser = undefined; throw error; });
  return parser;
}

/** CommonMark with GitHub extensions, LaTeX math and admonitions; no syntax that changes
 * the meaning of ordinary agent text (`_underline_`, `^sup^`, `~sub~`, `==mark==`). */
export async function parseMarkdown(markdown: string): Promise<MarkdownNode> {
  const parse = await load();
  // underline, latexMath, superscript, subscript, highlight, hardSoftBreaks, preserveBlankLines, admonitions
  const node = JSON.parse(parse(markdown, 0, 1, 0, 0, 0, 0, 0, 1)) as MarkdownNode;
  if (!node || typeof node.type !== 'string') throw new Error('Markdown could not be parsed.');
  return node;
}

const escapeText = (text: string) => text.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');
const text = (node: MarkdownNode): string => node.content ?? (node.children ?? []).map(text).join('');
const ADMONITIONS: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
const ALIGN = new Set(['left', 'center', 'right']);

/** Writes the tree as HTML. Math becomes inert placeholders that `typesetMath` fills in. */
export function renderMarkdown(root: MarkdownNode, options: RenderOptions = {}): string {
  const link = (url: string) => escapeAttr(options.link ? options.link(url) : url);
  const kids = (node: MarkdownNode) => (node.children ?? []).map(render).join('');
  const cell = (tag: string, node: MarkdownNode) => {
    const align = node.attributes?.align ?? '';
    return `<${tag}${ALIGN.has(align) ? ` class="md-align-${align}"` : ''}>${kids(node)}</${tag}>`;
  };
  function render(node: MarkdownNode): string {
    const a = node.attributes ?? {};
    switch (node.type) {
      case 'Document': return kids(node);
      // Tight list items hold their text directly, as CommonMark renders them.
      case 'Paragraph': return a.tight === 'true' ? kids(node) : `<p>${kids(node)}</p>\n`;
      case 'Text': return escapeText(node.content ?? '');
      case 'SoftBreak': return '\n';
      case 'LineBreak': return '<br>\n';
      case 'Heading': { const level = Math.min(6, Math.max(1, Number(a.level) || 1)); return `<h${level}>${kids(node)}</h${level}>\n`; }
      case 'Strong': return `<strong>${kids(node)}</strong>`;
      case 'Emphasis': return `<em>${kids(node)}</em>`;
      case 'Strikethrough': return `<del>${kids(node)}</del>`;
      case 'Underline': return `<u>${kids(node)}</u>`;
      case 'Superscript': return `<sup>${kids(node)}</sup>`;
      case 'Subscript': return `<sub>${kids(node)}</sub>`;
      case 'Highlight': return `<mark>${kids(node)}</mark>`;
      case 'Code': return `<code>${escapeText(text(node))}</code>`;
      case 'Link': return `<a href="${link(a.url ?? '')}"${a.title ? ` title="${escapeAttr(a.title)}"` : ''}>${kids(node)}</a>`;
      // Remote images are not loaded in the transcript; their description links to them instead.
      case 'Image': case 'Video': { const label = text(node) || a.title || (node.type === 'Video' ? 'Video' : 'Image'); return `<a class="md-media" href="${link(a.url ?? '')}">${escapeText(label)}</a>`; }
      case 'Blockquote': return `<blockquote>\n${kids(node)}</blockquote>\n`;
      case 'Admonition': {
        const type = ADMONITIONS[a.admonitionType ?? ''] ? a.admonitionType! : 'note';
        return `<aside class="md-admonition md-admonition-${type}" role="note"><p class="md-admonition-title">${ADMONITIONS[type]}</p>${kids(node)}</aside>\n`;
      }
      case 'UnorderedList': case 'OrderedList': {
        const tag = node.type === 'OrderedList' ? 'ol' : 'ul';
        const tasks = node.children?.some(item => item.attributes?.isTask === 'true');
        const start = Number(a.start);
        return `<${tag}${tasks ? ' class="md-task-list"' : ''}${tag === 'ol' && Number.isInteger(start) && start !== 1 ? ` start="${start}"` : ''}>\n${kids(node)}</${tag}>\n`;
      }
      case 'ListItem': {
        if (a.isTask !== 'true') return `<li>${kids(node)}</li>\n`;
        const done = a.taskChecked === 'true';
        return `<li class="md-task${done ? ' md-task-done' : ''}"><span class="md-checkbox" role="img" aria-label="${done ? 'Done' : 'Not done'}"></span>${kids(node)}</li>\n`;
      }
      case 'CodeBlock': {
        const language = (a.language ?? '').trim().split(/\s/)[0];
        return `<pre><code${language ? ` class="language-${escapeAttr(language)}"` : ''}>${escapeText(text(node))}</code></pre>\n`;
      }
      case 'ThematicBreak': return '<hr>\n';
      case 'Table': return `<table>\n${kids(node)}</table>\n`;
      case 'TableHead': return `<thead>\n${kids(node)}</thead>\n`;
      case 'TableBody': return `<tbody>\n${kids(node)}</tbody>\n`;
      case 'TableRow': return `<tr>${kids(node)}</tr>\n`;
      case 'TableHeaderCell': return cell('th', node);
      case 'TableCell': return cell('td', node);
      case 'LatexMathInline': return `<code class="md-math">${escapeText(text(node))}</code>`;
      case 'LatexMathDisplay': return `<pre class="md-math-display"><code class="md-math">${escapeText(text(node))}</code></pre>\n`;
      case 'BlankLine': return '';
      default: return kids(node);
    }
  }
  return render(root);
}

type Katex = { renderToString(tex: string, options: Record<string, unknown>): string };
let katex: Promise<Katex> | undefined;
const unescapeText = (html: string) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Replaces math placeholders in sanitized HTML with KaTeX output (which never runs code:
 * `trust` is off, so it emits no links, classes or styles from the formula). */
export async function typesetMath(html: string): Promise<string> {
  if (!html.includes('class="md-math"')) return html;
  katex ??= import('./math').then(module => module.default as Katex);
  const engine = await katex;
  const typeset = (tex: string, display: boolean) => {
    try { return engine.renderToString(unescapeText(tex), { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxExpand: 1000, maxSize: 20 }); }
    catch { return `<code class="md-math-error">${tex}</code>`; }
  };
  return html
    .replace(/<pre class="md-math-display"><code class="md-math">([\s\S]*?)<\/code><\/pre>/g, (_, tex: string) => `<div class="md-math-block">${typeset(tex, true)}</div>`)
    .replace(/<code class="md-math">([\s\S]*?)<\/code>/g, (_, tex: string) => typeset(tex, false));
}
