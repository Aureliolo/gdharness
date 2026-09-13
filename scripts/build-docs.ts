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

/** Counted rather than written down, so a tool added or dropped cannot leave the prose stale. */
const TOOL_COUNT = String(TOOL_SPECS.length);

/** The placeholders every page carries, so a command on the page is one the reader can run. */
function filled(text: string): string {
  return text.replaceAll('{{version}}', SERVER_VERSION).replaceAll('{{tools}}', TOOL_COUNT);
}

/** Where the site lives, for the canonical links and llms.txt. */
const SITE_URL = 'https://aureliolo.github.io/gdharness';

interface Page {
  /** The markdown file under docs/, or nothing for a page this script writes itself. */
  readonly source?: string;
  /** Where the rendered page lands, which is also its link. */
  readonly path: string;
  /** The same page as plain markdown, which is what an agent is pointed at. */
  readonly text: string;
  /** In the browser tab, and the heading of its nav entry. */
  readonly title: string;
  /** One line for llms.txt, which is the index an agent reads first. */
  readonly summary: string;
  /** The nav group it sits under. */
  readonly group: string;
  /** The front page is not a page of documentation and is not laid out like one. */
  readonly home?: boolean;
  readonly render?: () => string;
  readonly renderText?: () => string;
}

const PAGES: readonly Page[] = [
  {
    source: 'index.md',
    path: 'index.html',
    text: 'index.md',
    title: 'gdharness',
    summary: 'What gdharness is, what it is made of, and the rules it is built to.',
    group: 'Start',
    home: true,
  },
  {
    source: 'install.md',
    path: 'install.html',
    text: 'install.md',
    title: 'Install',
    summary: 'Installing and configuring it, step by step, with what to check after each.',
    group: 'Start',
  },
  {
    source: 'architecture.md',
    path: 'architecture.html',
    text: 'architecture.md',
    title: 'How it works',
    summary: 'The parts, what connects to what, the ports, and which tools use which.',
    group: 'Start',
  },
  {
    source: 'usage.md',
    path: 'usage.html',
    text: 'usage.md',
    title: 'Using it',
    summary: 'Which tools need the editor, how the game is run and read, and the ports.',
    group: 'Start',
  },
  {
    path: 'tools.html',
    text: 'tools.md',
    title: 'Tools',
    summary: 'Every tool, every op and every argument, generated from the server itself.',
    group: 'Reference',
    render: renderTools,
    renderText: renderToolsText,
  },
  {
    source: 'traps.md',
    path: 'traps.html',
    text: 'traps.md',
    title: 'Traps',
    summary: 'Five Godot behaviours that are still yours to know, and the ones already handled.',
    group: 'Reference',
  },
  {
    source: 'tested.md',
    path: 'tested.html',
    text: 'tested.md',
    title: 'What is proven',
    summary: 'Why the answers can be believed: what is driven against a real engine, and what is not.',
    group: 'Reference',
  },
];

/**
 * The one page written for an agent rather than for a reader, and the only one with no rendered
 * twin: it is published as markdown, listed in llms.txt, and left out of the navigation, because
 * a person who lands on it has been sent the wrong link.
 */
const AGENT_GUIDE = {
  source: 'agent.md',
  text: 'agent.md',
  summary: 'Do this to install gdharness into a project. Terse, imperative, for an agent.',
} as const;

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
    // A fence says its language and, after it, what the block is: ```bash verify the download.
    // The label becomes the bar along the top, which is what tells one block from the next when
    // a page is mostly commands.
    code(token: Tokens.Code) {
      const [language = '', ...rest] = (token.lang ?? '').split(' ');
      const label = rest.join(' ');
      const bar = label === '' ? '' : `<figcaption>${escaped(label)}</figcaption>`;
      return `<figure class="code">${bar}<pre><code>${coloured(token.text, language)}</code></pre></figure>\n`;
    },
  },
});

/**
 * The little colour a block of JSON or shell needs to be read at a glance.
 *
 * Hand-rolled and deliberately small: three tokens, no library, no theme to keep up with. Anything
 * it does not recognise comes out as plain text, which is the right failure for a highlighter.
 */
function coloured(code: string, language: string): string {
  const text = escaped(code);
  if (language === 'json' || language === 'jsonc') {
    return text
      .replaceAll(/^(\s*)(\/\/.*)$/gm, '$1<i class="c">$2</i>')
      .replaceAll(/&quot;([^&]*?)&quot;(\s*:)/g, '<i class="k">&quot;$1&quot;</i>$2')
      .replaceAll(/:(\s*)&quot;([^&]*?)&quot;/g, ':$1<i class="s">&quot;$2&quot;</i>')
      .replaceAll(/\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, '<i class="n">$1</i>');
  }
  if (language === 'bash' || language === 'sh') {
    return text
      .replaceAll(/(^|\s)(#.*)$/gm, '$1<i class="c">$2</i>')
      .replaceAll(/(^|\n)([a-z][\w.-]*)/g, '$1<i class="k">$2</i>')
      .replaceAll(/(\s)(--?[a-z][\w-]*)/g, '$1<i class="n">$2</i>');
  }
  return text;
}

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
    'related things takes an <code>op</code>. An unknown op or argument is refused with the valid set ',
    'listed. Generated from the server.</p>\n',
    '<h2 id="a-call-and-its-answer">A call and its answer</h2>\n',
    '<figure class="code"><pre><code>project_settings {\n',
    '  "projectPath": "/home/you/game",\n',
    '  "op": "set",\n',
    '  "setting": "display/window/size/viewport_width",\n',
    '  "value": 1280\n',
    '}\n\n',
    '{\n',
    '  "setting_path": "display/window/size/viewport_width",\n',
    '  "old_value": 1152,\n',
    '  "new_value": 1280,\n',
    '  "was_new": false,\n',
    '  "saved": true\n',
    '}\n</code></pre></figure>\n',
    '<p><code>new_value</code> is read from the engine after the write. Engine stderr comes back ',
    'under <code>engine_messages</code>. Every call takes <code>projectPath</code>, except the ',
    '<code>runtime_*</code> and <code>debug_*</code> tools, where it picks between running games.</p>\n',
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

/**
 * The same reference as markdown, which is what an agent gets pointed at.
 *
 * An agent handed an HTML page pays for the chrome, the navigation and the stylesheet link before
 * it reaches a sentence, so every page here has a plain twin and the links written for agents go
 * to those.
 */
function renderToolsText(): string {
  const lines: string[] = [
    '# Tools',
    '',
    `${TOOL_SPECS.length} tools, named \`domain_verb\`. A tool that does several related things takes an`,
    '`op`. An unknown op or argument is refused with the valid set listed. Generated from the server.',
    '',
    'Every call takes `projectPath`, except the `runtime_*` and `debug_*` tools, where it picks',
    'between running games. Answers are read from the engine after the change, not echoed from the',
    'request. Engine stderr comes back under `engine_messages`.',
    '',
  ];

  for (const tool of TOOL_SPECS) {
    lines.push(`## ${tool.name}`, '', tool.description, '');

    const operations = Object.entries(tool.operations ?? {});
    if (operations.length > 0) {
      for (const [op, spec] of operations) {
        const needs = [...tool.requires, ...spec.requires];
        const isDefault = tool.defaultOperation === op ? ' (default)' : '';
        const wants = needs.length > 0 ? ` Needs: ${needs.map((name) => `\`${name}\``).join(', ')}.` : '';
        lines.push(`- \`op: ${op}\`${isDefault}: ${spec.summary}.${wants}`);
      }
      lines.push('');
    } else if (tool.requires.length > 0) {
      lines.push(`Needs: ${tool.requires.map((name) => `\`${name}\``).join(', ')}.`, '');
    }

    const parameters = Object.entries(tool.parameters).filter(([name]) => name !== 'projectPath');
    if (parameters.length > 0) {
      lines.push('Arguments:', '');
      for (const [name, schema] of parameters) {
        const type = typeof schema['type'] === 'string' ? schema['type'] : 'any';
        const note = typeof schema['description'] === 'string' ? ` ${schema['description']}` : '';
        lines.push(`- \`${name}\` (${type}):${note}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
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

/**
 * The index an agent reads before it reads anything else.
 *
 * Every link goes to the markdown rather than to the rendered page, and the first one is the guide
 * written for an agent rather than for a reader.
 */
function renderLlmsTxt(): string {
  const lines = [
    '# gdharness',
    '',
    '> A harness for driving a Godot 4 project from an agent: three addons that make the editor',
    '> and the running game answerable, a server that puts them in front of an agent as tools,',
    '> engine operations that answer with nothing open, and a command line that installs it all.',
    '',
    `Version ${SERVER_VERSION}. Every release is signed and carries a build attestation, and the`,
    'install guide below refuses to go on without checking it.',
    '',
    '## Start here',
    '',
    `- [Install it into a project](${SITE_URL}/${AGENT_GUIDE.text}): ${AGENT_GUIDE.summary}`,
    '',
    '## Docs',
    '',
  ];
  for (const page of PAGES) {
    lines.push(`- [${page.title}](${SITE_URL}/${page.text}): ${page.summary}`);
  }
  lines.push(
    '',
    '## Optional',
    '',
    `- [Everything above, in one file](${SITE_URL}/llms-full.txt)`,
    '- [Repository](https://github.com/Aureliolo/gdharness)',
    '',
  );
  return lines.join('\n');
}

function build(): void {
  const template = readFileSync(join(THEME, 'page.html'), 'utf8');

  // A markdown file nobody listed is a page with no way to reach it, which is worse than one
  // that does not exist: it publishes and nothing links to it.
  const listed = new Set(
    [...PAGES.map((page) => page.source), AGENT_GUIDE.source].filter((source) => source !== undefined),
  );
  const orphans = readdirSync(DOCS)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .filter((name) => !listed.has(name));
  if (orphans.length > 0) {
    throw new Error(`docs/${orphans.join(', docs/')} would publish with nothing linking to them.`);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /** The markdown of one page, filled in, which is what the text twin holds. */
  const textOf = (page: { source?: string; renderText?: () => string }): string =>
    filled(
      page.renderText !== undefined ? page.renderText() : readFileSync(join(DOCS, page.source ?? ''), 'utf8'),
    );

  for (const page of PAGES) {
    const rendered =
      page.render !== undefined
        ? page.render()
        : marked.parse(readFileSync(join(DOCS, page.source ?? ''), 'utf8'), { async: false });
    // A table is the one thing here that cannot be made to fit a phone, so it gets to scroll
    // inside its own box rather than taking the page sideways with it. The opening paragraph
    // is the lede, which is a presentation decision and so belongs here rather than as markup
    // inside the markdown.
    const content = filled(
      rendered
        .replaceAll('<table>', '<div class="scroll"><table>')
        .replaceAll('</table>', '</table></div>')
        .replace(/(<\/h1>\s*)<p>/, '$1<p class="lede">'),
    );
    const html = filled(
      template
        .replaceAll(
          '{{title}}',
          escaped(page.path === 'index.html' ? page.title : `${page.title} · gdharness`),
        )
        .replaceAll('{{description}}', escaped(page.summary))
        .replaceAll('{{canonical}}', `${SITE_URL}/${page.path}`)
        .replaceAll('{{nav}}', renderNav(page.path)),
    ).replaceAll('{{content}}', content);
    writeFileSync(join(OUT, page.path), html, 'utf8');
    writeFileSync(join(OUT, page.text), textOf(page), 'utf8');
  }

  // The guide written for an agent: markdown only, and in no navigation. A person who lands on it
  // was sent the wrong link.
  writeFileSync(join(OUT, AGENT_GUIDE.text), textOf(AGENT_GUIDE), 'utf8');

  cpSync(join(THEME, 'site.css'), join(OUT, 'site.css'));
  writeFileSync(join(OUT, 'llms.txt'), renderLlmsTxt(), 'utf8');
  // The whole of it in one fetch, for a reader that would rather not make eight.
  writeFileSync(
    join(OUT, 'llms-full.txt'),
    [textOf(AGENT_GUIDE), ...PAGES.map(textOf)].join('\n\n---\n\n'),
    'utf8',
  );
  // GitHub Pages runs Jekyll over what it is given unless told not to, and Jekyll drops every
  // file whose name begins with an underscore.
  writeFileSync(join(OUT, '.nojekyll'), '', 'utf8');

  console.log(`built ${PAGES.length} pages, ${PAGES.length + 1} text files, into ${OUT}/`);
}

try {
  build();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
