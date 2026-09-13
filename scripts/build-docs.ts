#!/usr/bin/env bun
/**
 * The public site: markdown in, HTML out, one template and one stylesheet, both ours.
 *
 * Hand-rolled rather than a site framework because the site is small, the repository is
 * TypeScript, and a bespoke look is the point: a generator we own is less to carry than a
 * theme we would spend the same effort overriding.
 *
 * The tool reference is rendered from the tool definitions themselves, so it cannot drift from
 * what the server answers, and it is never committed.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { marked, type Tokens } from 'marked';
import { SERVER_VERSION } from '../src/server-version.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';

const DOCS = 'docs';
const THEME = join(DOCS, 'theme');
const OUT = 'site';

/** Where the site lives, for the canonical links and llms.txt. */
const SITE_URL = 'https://aureliolo.github.io/gdharness';

interface Page {
  /** The markdown file under docs/, or nothing for a page this script writes itself. */
  readonly source?: string;
  /** Where it lands, which is also its link. */
  readonly path: string;
  /** In the browser tab, and the heading of its nav entry. */
  readonly title: string;
  /** One line for llms.txt, which is the index an agent reads. */
  readonly summary: string;
  /** The nav group it sits under. */
  readonly group: string;
  readonly render?: () => string;
}

const PAGES: readonly Page[] = [
  {
    source: 'index.md',
    path: 'index.html',
    title: 'gdharness',
    summary: 'What gdharness is, what it needs, and the rules it is built to.',
    group: 'Start',
  },
  {
    source: 'install.md',
    path: 'install.html',
    title: 'Install',
    summary: 'How to install and configure gdharness, written for the agent doing it.',
    group: 'Start',
  },
  {
    source: 'usage.md',
    path: 'usage.html',
    title: 'Using it',
    summary: 'Which tools need the editor, how the game is run and read, and the ports.',
    group: 'Start',
  },
  {
    path: 'tools.html',
    title: 'Tools',
    summary: 'Every tool, every op and every argument, generated from the server itself.',
    group: 'Reference',
    render: renderTools,
  },
  {
    source: 'traps.md',
    path: 'traps.html',
    title: 'Traps',
    summary: 'What Godot does that costs an afternoon, and what to do instead.',
    group: 'Reference',
  },
  {
    source: 'release-process.md',
    path: 'releases.html',
    title: 'Release process',
    summary: 'How a release is cut, signed, and verified by whoever installs it.',
    group: 'Reference',
  },
];

/** A heading's own link, from its words: what a reader copies to point somebody at a section. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

marked.use({
  renderer: {
    heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Heading) {
      const text = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${slug(token.text)}">${text}</h${token.depth}>\n`;
    },
  },
});

/** Anything that ends up in HTML and did not come from the markdown renderer. */
function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The tool reference, from the definitions the server answers with. */
function renderTools(): string {
  const parts: string[] = [
    `<p class="lede">${TOOL_SPECS.length} tools, named <code>domain_verb</code>. A tool that does several `,
    'related things takes an <code>op</code>; an op it has not got is refused with the valid set spelled ',
    'out, and so is an argument it does not name. Every answer is read back from the engine after the ',
    'change rather than echoed from the request.</p>\n',
    '<p class="lede">This page is generated from the server, so it says what the server says.</p>\n',
  ];

  const family = (name: string): string => name.split('_')[0] ?? name;
  let current = '';
  for (const tool of TOOL_SPECS) {
    if (family(tool.name) !== current) {
      current = family(tool.name);
      parts.push(`<h2 id="${current}">${escaped(current)}</h2>\n`);
    }

    parts.push(`<section class="tool" id="${escaped(tool.name)}">\n`);
    parts.push(`<h3><code>${escaped(tool.name)}</code></h3>\n`);
    parts.push(`<p>${escaped(tool.description)}</p>\n`);

    const operations = Object.entries(tool.operations ?? {});
    if (operations.length > 0) {
      parts.push('<table><thead><tr><th>op</th><th>what it does</th><th>needs</th></tr></thead><tbody>\n');
      for (const [op, spec] of operations) {
        const needs = [...tool.requires, ...spec.requires];
        const isDefault = tool.defaultOperation === op ? ' <span class="tag">default</span>' : '';
        parts.push(
          `<tr><td><code>${escaped(op)}</code>${isDefault}</td><td>${escaped(spec.summary)}</td>` +
            `<td>${needs.map((name) => `<code>${escaped(name)}</code>`).join(' ') || '&mdash;'}</td></tr>\n`,
        );
      }
      parts.push('</tbody></table>\n');
    } else if (tool.requires.length > 0) {
      parts.push(
        `<p class="needs">Needs ${tool.requires.map((name) => `<code>${escaped(name)}</code>`).join(', ')}.</p>\n`,
      );
    }

    const parameters = Object.entries(tool.parameters).filter(([name]) => name !== 'projectPath');
    if (parameters.length > 0) {
      parts.push('<details><summary>Arguments</summary>\n<dl class="args">\n');
      for (const [name, schema] of parameters) {
        const type = typeof schema['type'] === 'string' ? schema['type'] : 'any';
        const note = typeof schema['description'] === 'string' ? schema['description'] : '';
        parts.push(
          `<dt><code>${escaped(name)}</code> <span class="type">${escaped(type)}</span></dt>` +
            `<dd>${escaped(note)}</dd>\n`,
        );
      }
      parts.push('</dl>\n</details>\n');
    }
    parts.push('</section>\n');
  }
  return parts.join('');
}

/** The navigation, which is the page list: a page outside it would be one nothing links to. */
function renderNav(current: string): string {
  const groups = new Map<string, Page[]>();
  for (const page of PAGES) {
    groups.set(page.group, [...(groups.get(page.group) ?? []), page]);
  }

  const parts: string[] = [];
  for (const [group, pages] of groups) {
    parts.push(`<span class="grp">${escaped(group)}</span>`);
    for (const page of pages) {
      const here = page.path === current ? ' class="on" aria-current="page"' : '';
      parts.push(`<a href="${page.path}"${here}>${escaped(page.title)}</a>`);
    }
  }
  return parts.join('\n');
}

/** The index an agent reads before it reads anything else. */
function renderLlmsTxt(): string {
  const lines = [
    '# gdharness',
    '',
    '> An MCP server for driving a Godot 4 project: the editor, the running game, the language',
    '> server, the debugger and the project files, as tools an agent can call.',
    '',
    `Version ${SERVER_VERSION}. Every release is signed and carries a build attestation; install.html`,
    'says how to check it before running anything.',
    '',
    '## Docs',
    '',
  ];
  for (const page of PAGES) {
    lines.push(`- [${page.title}](${SITE_URL}/${page.path}): ${page.summary}`);
  }
  lines.push('', '## Source', '', `- [Repository](https://github.com/Aureliolo/gdharness)`, '');
  return lines.join('\n');
}

function build(): void {
  const template = readFileSync(join(THEME, 'page.html'), 'utf8');

  // A markdown file nobody listed is a page with no way to reach it, which is worse than one
  // that does not exist: it publishes and nothing links to it.
  const listed = new Set(PAGES.map((page) => page.source).filter((source) => source !== undefined));
  const orphans = readdirSync(DOCS)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .filter((name) => !listed.has(name));
  if (orphans.length > 0) {
    throw new Error(`docs/${orphans.join(', docs/')} would publish with nothing linking to them.`);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const page of PAGES) {
    const rendered =
      page.render !== undefined
        ? page.render()
        : marked.parse(readFileSync(join(DOCS, page.source ?? ''), 'utf8'), { async: false });
    // A table is the one thing here that cannot be made to fit a phone, so it gets to scroll
    // inside its own box rather than taking the page sideways with it. The opening paragraph
    // is the lede, which is a presentation decision and so belongs here rather than as markup
    // inside the markdown.
    const content = rendered
      .replaceAll('<table>', '<div class="scroll"><table>')
      .replaceAll('</table>', '</table></div>')
      .replace(/(<\/h1>\s*)<p>/, '$1<p class="lede">');
    const html = template
      .replaceAll('{{title}}', escaped(page.path === 'index.html' ? page.title : `${page.title} · gdharness`))
      .replaceAll('{{description}}', escaped(page.summary))
      .replaceAll('{{canonical}}', `${SITE_URL}/${page.path}`)
      .replaceAll('{{nav}}', renderNav(page.path))
      .replaceAll('{{version}}', escaped(SERVER_VERSION))
      .replaceAll('{{content}}', content);
    writeFileSync(join(OUT, page.path), html, 'utf8');
  }

  cpSync(join(THEME, 'site.css'), join(OUT, 'site.css'));
  writeFileSync(join(OUT, 'llms.txt'), renderLlmsTxt(), 'utf8');
  // GitHub Pages runs Jekyll over what it is given unless told not to, and Jekyll drops every
  // file whose name begins with an underscore.
  writeFileSync(join(OUT, '.nojekyll'), '', 'utf8');

  console.log(`built ${PAGES.length} pages into ${OUT}/`);
}

try {
  build();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
