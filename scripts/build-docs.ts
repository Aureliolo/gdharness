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
import { displayPath, HARNESSES, type Harness, runLine } from '../src/harnesses.js';
import { SERVER_VERSION } from '../src/server-version.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';
import { renderToolsMarkdown } from '../src/tool-reference.js';

const DOCS = 'docs';
const THEME = join(DOCS, 'theme');
const OUT = 'site';

/** Counted rather than written down, so a tool added or dropped cannot leave the prose stale. */
const TOOL_COUNT = String(TOOL_SPECS.length);

/**
 * Every harness gdharness can write itself into, as a markdown table.
 *
 * From the same table `gdharness setup` reads, so the page cannot list a harness the command
 * does not know or miss one it does.
 */
function renderHarnesses(): string {
  const rows = HARNESSES.map((harness) => {
    const file = `\`${displayPath(harness, 'linux')}\``;
    const how = harness.snippet === undefined ? 'written for you' : 'prints the block to paste';
    const scope = harness.scope === 'project' ? 'project' : 'machine-wide';
    const skills =
      harness.skills === undefined ? '`.agents/skills`' : `\`${harness.skills.dir.replaceAll('\\', '/')}\``;
    return `| ${harness.name} | \`--${harness.id}\` | ${file} | ${scope} | ${how} | ${skills} |`;
  });
  return [
    '| Harness | Flag | Config | Scope | How | Skill |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * The same command under both runners, one line each.
 *
 * Either works, so showing one and mentioning the other in prose leaves half the readers doing a
 * translation in their head.
 */
function bothRunners(rest: string): string {
  return [runLine('npx', SERVER_VERSION, rest), runLine('bunx', SERVER_VERSION, rest)].join('\n');
}

/**
 * Every harness, by name.
 *
 * All of them rather than a chosen few, and alphabetical rather than in table order: any shorter
 * list is somebody's judgement about whose harness matters, and the table's own order puts the
 * four that share `.mcp.json` first, which would read as a ranking it is not.
 */
function pickable(): readonly Harness[] {
  return [...HARNESSES].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

/**
 * The install picker: choose a harness, read the one command and the one file it writes.
 *
 * Radio inputs and sibling selectors, so it works with no JavaScript at all, and generated from
 * the harness table so a panel cannot describe a harness `setup` does not know.
 */
function renderPicker(): string {
  const chosen = pickable();

  const inputs = chosen.map(
    (harness, index) =>
      `<input type="radio" name="harness" id="pick-${harness.id}"${index === 0 ? ' checked' : ''} />`,
  );
  const chips = chosen.map((harness) => `<label for="pick-${harness.id}">${escaped(harness.name)}</label>`);
  const panels = chosen.map((harness) => {
    const command = bothRunners(`setup . --${harness.id}`);
    const where =
      harness.scope === 'project'
        ? `Writes <code>${escaped(displayPath(harness, 'linux'))}</code> inside the project.`
        : `${escaped(harness.name)} has no project-level config, so this writes <code>${escaped(displayPath(harness, 'linux'))}</code> and affects every project you open with it.`;
    const how =
      harness.snippet === undefined
        ? ''
        : ' Its file is documented but the key it holds servers under is not, so this prints the block rather than guessing.';
    const left = harness.manual === undefined ? '' : ` ${escaped(harness.manual)}`;
    const skill = harness.skills === undefined ? '.agents/skills' : harness.skills.dir.replaceAll('\\', '/');
    return [
      `<div class="panel panel-${harness.id}">`,
      `<pre><code>${codeText(command)}</code></pre>`,
      `<p>${where}${how} The skill goes to <code>${escaped(skill)}</code>.${left}</p>`,
      '</div>',
    ].join('');
  });

  // Last, and deliberately at the same level as the rest: the reader whose harness is not here is
  // not out of luck, because the thing being installed is an ordinary MCP server.
  inputs.push('<input type="radio" name="harness" id="pick-other" />');
  chips.push('<label for="pick-other">Something else</label>');
  panels.push(
    [
      '<div class="panel panel-other">',
      `<pre><code>${codeText(bothRunners('setup .'))}</code></pre>`,
      '<p>Any MCP client that can spawn a local stdio server will do. With no harness named it asks about the ones it finds, and the entry it writes is the same everywhere. <a href="architecture.html">How it works</a> has every file and key, and says which ones it cannot write for you.</p>',
      '</div>',
    ].join(''),
  );

  // The rules tying each input to its chip and its panel are generated with them, so a harness
  // added to the table cannot outrun a hand-maintained stylesheet.
  const rules = [...chosen.map((harness) => harness.id), 'other'].flatMap((id) => [
    `#pick-${id}:checked ~ .panels .panel-${id}{display:block}`,
    `#pick-${id}:checked ~ .chips label[for="pick-${id}"]{color:var(--signal-ink);background:var(--signal);border-color:var(--signal)}`,
    `#pick-${id}:focus-visible ~ .chips label[for="pick-${id}"]{outline:2px solid var(--signal);outline-offset:2px}`,
  ]);

  return [
    '<div class="picker">',
    `<style>${rules.join('')}</style>`,
    ...inputs,
    `<div class="chips">${chips.join('')}</div>`,
    `<div class="panels">${panels.join('')}</div>`,
    '</div>',
  ].join('\n');
}

/** The same choice as plain markdown, for the twin an agent reads. */
function renderPickerText(): string {
  const rows = pickable().map(
    (harness) => `| ${harness.name} | \`--${harness.id}\` | \`${displayPath(harness, 'linux')}\` |`,
  );
  return [
    'Every harness takes the same command with its own flag, under either runner:',
    '',
    '```bash',
    bothRunners('setup . --<harness>'),
    '```',
    '',
    'Leave the flag off and it asks about the ones it finds.',
    '',
    '| Harness | Flag | Writes |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Not listed is not unsupported: any MCP client that can spawn a local stdio server will do.',
  ].join('\n');
}

/**
 * The placeholders every page carries, so a command on the page is one the reader can run.
 *
 * The markdown twin gets the same facts without the markup: a reader who asked for markdown is
 * usually an agent, and a picker made of radio inputs is nothing to it.
 */
function filled(text: string, markup = true): string {
  return text
    .replaceAll('{{version}}', SERVER_VERSION)
    .replaceAll('{{tools}}', TOOL_COUNT)
    .replaceAll('{{harnesses}}', renderHarnesses())
    .replaceAll('{{picker}}', markup ? renderPicker() : renderPickerText());
}

/** The three things gdharness is made of, and where each one is documented. */
const PARTS = [
  {
    kicker: 'Inside Godot',
    title: 'Three addons',
    body: 'They make the open editor and the running game answerable, and reload the editor when files change on disk.',
    link: 'architecture.html',
    linkText: 'How it works',
  },
  {
    kicker: 'The server',
    title: `${TOOL_COUNT} tools`,
    body: 'Named <code>domain_verb</code>, with four <code>godot://</code> resources. An unknown op is refused with the valid set listed.',
    link: 'tools.html',
    linkText: 'Tool reference',
  },
  {
    kicker: 'The CLI',
    title: 'One command',
    body: 'Addons in, plugins on, class list rebuilt, the skill written, and the server registered with your harness.',
    link: 'install.html',
    linkText: 'Install',
  },
];

/**
 * The front page: a statement, the two ways in, and three cards that route you onward.
 *
 * Built here rather than from markdown because a hero and a row of cards are not prose, and
 * writing them as raw HTML inside a markdown file would be the worst of both.
 */
function renderHome(): string {
  const paste = [
    'Install gdharness into this project by following',
    'https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to',
    'recommend back to me.',
  ].join('\n');

  const cards = PARTS.map((part) =>
    [
      '<div class="card">',
      `<span class="kicker">${escaped(part.kicker)}</span>`,
      `<h3>${escaped(part.title)}</h3>`,
      `<p>${part.body}</p>`,
      `<a class="go" href="${part.link}">${escaped(part.linkText)}</a>`,
      '</div>',
    ].join(''),
  );

  return [
    '<section class="hero">',
    '<h1>Make the engine answer.</h1>',
    '<p class="sub">Your agent can see the editor you have open, the game that is running, and the project on disk, and it can change all three.</p>',
    '</section>',
    `<div class="cards">${cards.join('')}</div>`,
    '<section class="install">',
    '<h2 class="step">Hand it to your agent</h2>',
    `<figure class="code"><figcaption>paste this</figcaption><pre><code>${codeText(paste)}</code></pre></figure>`,
    '<p class="note">It reads the guide, installs the addons, writes the config for the harness it is running in, and reports the two things it cannot do for itself.</p>',
    '<h2 class="step">Or do it yourself</h2>',
    renderPicker(),
    '<p class="note">With no harness named it asks about each one it finds, here or on this machine, and writes nothing outside the project directory without a flag or a typed yes. <a href="architecture.html">How it works</a> has every harness it knows.</p>',
    '</section>',
    '<p class="smallprint">Fork of <a href="https://github.com/HaD0Yun/Doyunha-Gopeak">GoPeak</a> v2.3.9, September 2026, MIT: the original MCP server <a href="https://github.com/Coding-Solo/godot-mcp">godot-mcp</a> by <a href="https://github.com/Coding-Solo">Solomon Elias</a>, GoPeak by <a href="https://github.com/HaD0Yun">HaD0Yun</a>, and completely reworked since to be hardened, condensed and more streamlined. Not affiliated with GoPeak or the Godot Foundation.</p>',
  ].join('\n');
}

/** The same page as markdown, which is what an agent is pointed at. */
function renderHomeText(): string {
  return [
    '# gdharness',
    '',
    'Drive a Godot 4 project from an agent: the editor that is open, the game that is running, and',
    'the project on disk. An agent cannot see a running game; this makes one answerable.',
    '',
    'Godot 4.7 or newer, and Node 22 or newer for `npx`. It runs under Bun 1.4 too.',
    '',
    '## Install',
    '',
    '```text hand this to an agent',
    'Install gdharness into this project by following',
    'https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to',
    'recommend back to me.',
    '```',
    '',
    'Or run it yourself. It is the same command every time; what changes is the file it writes.',
    '',
    '{{picker}}',
    '',
    'With no harness named it asks about each one it finds, here or on this machine, and writes',
    'nothing outside the project directory without a flag or a typed yes.',
    '',
    '## Three parts',
    '',
    '**Inside Godot.** Three addons in your project. They make the open editor and the running game',
    'answerable, and reload the editor when files change on disk.',
    '',
    `**The MCP server.** ${TOOL_COUNT} tools named \`domain_verb\`, and four \`godot://\` resources. An`,
    'unknown op or argument is refused with the valid set listed, and every answer is read back from',
    'the engine rather than echoed from the request.',
    '',
    '**The CLI.** Installs the addons, writes the skill, registers the server, checks all of it, and',
    'takes it back out again.',
    '',
    '## Pages',
    '',
    '- [Install](install.md): install, verify, update, uninstall.',
    '- [How it works](architecture.md): what an install writes, how it decides, and what talks to',
    '  what once it is running.',
    '- [Tools](tools.md): every tool, op and argument.',
    '',
    '## Project',
    '',
    'Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT: the',
    'original MCP server [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by',
    '[Solomon Elias](https://github.com/Coding-Solo), GoPeak by [HaD0Yun](https://github.com/HaD0Yun),',
    'and completely reworked since to be hardened, condensed and more streamlined. Not affiliated with',
    'GoPeak or the Godot Foundation.',
    '',
  ].join('\n');
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
  /** In the browser tab, and in the navigation unless `nav` says otherwise. */
  readonly title: string;
  /** What the navigation calls it, where the title would read oddly in a row of links. */
  readonly nav?: string;
  /** One line for llms.txt, which is the index an agent reads first. */
  readonly summary: string;
  /** The front page is not a page of documentation and is not laid out like one. */
  readonly home?: boolean;
  readonly render?: () => string;
  readonly renderText?: () => string;
}

const PAGES: readonly Page[] = [
  {
    path: 'index.html',
    text: 'index.md',
    title: 'gdharness',
    // The wordmark beside it already says gdharness, and the same word twice in a row of links
    // reads as a mistake rather than as a destination.
    nav: 'Overview',
    summary: 'What gdharness is, what it is made of, and the rules it is built to.',
    home: true,
    render: renderHome,
    renderText: renderHomeText,
  },
  {
    source: 'install.md',
    path: 'install.html',
    text: 'install.md',
    title: 'Install',
    summary: 'Installing and configuring it, step by step, with what to check after each.',
  },
  {
    source: 'architecture.md',
    path: 'architecture.html',
    text: 'architecture.md',
    title: 'How it works',
    summary: 'The parts, what connects to what, the ports, and which tools use which.',
  },
  {
    path: 'tools.html',
    text: 'tools.md',
    title: 'Tools',
    summary: 'Every tool, every op and every argument, generated from the server itself.',
    render: renderTools,
    renderText: renderToolsMarkdown,
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
      codeBlocks.push(token.text);
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

/** One call and the answer it comes back with, which is what the whole reference is a list of. */
const EXAMPLE_CALL = `project_settings {
  "projectPath": "/home/you/game",
  "op": "set",
  "setting": "display/window/size/viewport_width",
  "value": 1280
}

{
  "setting_path": "display/window/size/viewport_width",
  "old_value": 1152,
  "new_value": 1280,
  "was_new": false,
  "saved": true
}
`;

/** The tool reference, from the definitions the server answers with. */
function renderTools(): string {
  const parts: string[] = [
    // Every other page opens with its own name, because the markdown behind it starts with one.
    // This page is built rather than parsed, so it has to say so itself.
    '<h1>Tools</h1>\n',
    `<p class="lede">${TOOL_SPECS.length} tools, named <code>domain_verb</code>. A tool that does several `,
    'related things takes an <code>op</code>. An unknown op or argument is refused with the valid set ',
    'listed. Generated from the server.</p>\n',
    '<h2 id="a-call-and-its-answer">A call and its answer</h2>\n',
    `<figure class="code"><pre><code>${codeText(EXAMPLE_CALL)}</code></pre></figure>\n`,
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
/**
 * The one navigation, on every page and listing every page including the front one.
 *
 * It is the page list, so a page outside it is one nothing links to, and there is nowhere for a
 * second copy to drift out of step with the first.
 */
function renderTopLinks(current: string): string {
  return PAGES.map((page) => {
    const here = page.path === current ? ' class="on" aria-current="page"' : '';
    return `<a href="${page.path}"${here}>${escaped(page.nav ?? page.title)}</a>`;
  }).join('\n          ');
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
  // One template for every page, the front one included. It had a second copy of its own for a
  // while, and the copy went on linking to a page that had been deleted: the same chrome written
  // twice is the same chrome wrong once. What the front page needs instead is a class on the
  // body, which its own block in the stylesheet hangs off.
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
      false,
    );

  for (const page of PAGES) {
    // Substituted before parsing, not after, so that a generated table arrives as markdown and
    // is rendered as a table rather than dropped into the page as its own source.
    const rendered =
      page.render !== undefined
        ? page.render()
        : marked.parse(filled(readFileSync(join(DOCS, page.source ?? ''), 'utf8')), { async: false });
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
      .replaceAll('{{bodyclass}}', page.home === true ? ' class="home"' : '')
      .replaceAll('{{description}}', escaped(page.summary))
      .replaceAll('{{canonical}}', `${SITE_URL}/${page.path}`)
      .replaceAll('{{toplinks}}', renderTopLinks(page.path))
      .replaceAll('{{version}}', escaped(SERVER_VERSION))
      .replaceAll('{{content}}', content);
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

  checkOutput();
  console.log(`built ${PAGES.length} pages, ${PAGES.length + 1} text files, into ${OUT}/`);
}

/**
 * How wide a line of code may be before it stops fitting the one column.
 *
 * A block that does not fit either slides sideways, hiding half of itself behind a gesture
 * nobody makes, or wraps and loses the alignment it was drawn with. Both are the document's
 * fault rather than the stylesheet's, so the build says which line is too long and the document
 * is written to fit.
 */
const CODE_COLUMNS = 84;

/**
 * Every code block, as the text it was written as, collected while the pages render.
 *
 * Kept here rather than read back out of the HTML: by then the highlighter has wrapped each token
 * in markup and escaped the text, and measuring that means stripping tags and decoding entities,
 * which is indistinguishable from a sanitiser that does not work. The source is the thing being
 * measured anyway.
 */
const codeBlocks: string[] = [];

/**
 * A block of code, escaped for the page and measured on the way through.
 *
 * Every code block goes through this or through the markdown renderer, so one built by hand in
 * this file is as answerable for fitting the column as one written in a document.
 */
function codeText(text: string): string {
  codeBlocks.push(text);
  return escaped(text);
}

/** Every id a page offers, which is what a `#fragment` pointed at it has to find. */
function anchorsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? ''));
}

/** Every link a file makes, whether it is written as HTML, as markdown, or bare in angles. */
function linksIn(text: string): string[] {
  const patterns = [
    /href="([^"]*)"/g,
    /\[[^\]]*\]\(([^)\s]+)\)/g,
    /<([\w.-]+\.(?:html|md|txt)(?:#[^>\s]*)?)>/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ''));
}

/**
 * Text that is not tab, newline or carriage return but is still below a space.
 *
 * Compared by code point rather than matched by a character class: writing that class means
 * putting escapes in a regular expression, and an escape in this file is exactly what got
 * mangled into a raw control byte last time.
 */
/**
 * Box drawing and block elements, which look like the obvious way to draw a diagram and are not.
 *
 * IBM Plex Mono has no glyphs in these blocks, so the browser draws them from whatever other font
 * it can find, at that font's advance width. The verticals then sit off the columns they were
 * aligned to and the horizontals come apart, which is what every one of these diagrams did on the
 * live site. ASCII draws the same picture out of characters the face actually has.
 */
function drawingCharactersIn(text: string): string[] {
  const found = new Set<string>();
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // U+2190..U+21FF arrows, U+2500..U+257F box drawing, U+2580..U+259F block elements.
    if ((code >= 0x2190 && code <= 0x21ff) || (code >= 0x2500 && code <= 0x259f)) {
      found.add(character);
    }
  }
  return [...found];
}

function controlCharactersIn(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      found.push(code);
    }
  }
  return found;
}

/**
 * What the build refuses to publish.
 *
 * Both of these shipped once. A page was deleted while the front page's hand-written link row
 * went on pointing at it, and a CSS escape was mangled into a control byte that rendered as an
 * empty box on every card. Neither is something a person notices by reading the source, and both
 * are one pass over the output to catch.
 */
function checkOutput(): void {
  const names = readdirSync(OUT);
  const published = new Set(names);
  const anchors = new Map<string, Set<string>>();
  for (const name of names.filter((file) => file.endsWith('.html'))) {
    anchors.set(name, anchorsIn(readFileSync(join(OUT, name), 'utf8')));
  }

  const wrong: string[] = [];
  for (const line of codeBlocks.flatMap((block) => block.split('\n'))) {
    if (line.length > CODE_COLUMNS) {
      wrong.push(`a code line is ${line.length} characters, ${CODE_COLUMNS} fit: ${line.slice(0, 56)}...`);
    }
    const drawn = drawingCharactersIn(line);
    if (drawn.length > 0) {
      wrong.push(
        `a code line draws with ${drawn.join(' ')}, which the mono face has no glyphs for: ${line.slice(0, 40)}...`,
      );
    }
  }

  for (const name of names.filter((file) => /\.(?:html|md|txt|css)$/.test(file))) {
    const text = readFileSync(join(OUT, name), 'utf8');
    for (const code of controlCharactersIn(text)) {
      wrong.push(`${name} holds the control character U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
    }

    for (const link of linksIn(text)) {
      // Anything with a scheme, and anything protocol-relative, is somebody else's to serve.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) {
        continue;
      }
      const [target = '', fragment = ''] = link.split('#');
      const file = target === '' ? name : target;
      if (!published.has(file)) {
        wrong.push(`${name} links to ${link}, and ${file} is not published`);
        continue;
      }
      // Only a rendered page has ids to look for. A fragment into markdown is whatever anchor
      // the reader's own renderer makes of a heading, which nothing here decides.
      const known = anchors.get(file);
      if (fragment !== '' && known !== undefined && !known.has(fragment)) {
        wrong.push(`${name} links to ${link}, and ${file} has no id="${fragment}"`);
      }
    }
  }

  if (wrong.length > 0) {
    throw new Error(`the site would publish broken:\n  ${wrong.join('\n  ')}`);
  }
}

try {
  build();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
