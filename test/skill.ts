#!/usr/bin/env bun
/**
 * The skill gdharness writes into a project.
 *
 * Two things have to hold. It has to satisfy the Agent Skills format, because a skill whose
 * frontmatter is wrong is one every harness silently ignores. And it has to land where the
 * harnesses actually being set up will look, which for three of them is not the shared directory.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES, harnessById } from '../src/harnesses.js';
import {
  removeSkill,
  SHARED_SKILLS,
  SKILL_NAME,
  skillDirectories,
  skillFiles,
  writeSkill,
} from '../src/skill.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'gdharness-skill-'));
}

/** The frontmatter, as the specification defines it rather than as YAML in general. */
function frontmatter(text: string): Record<string, string> {
  assert.ok(text.startsWith('---\n'), 'the file opens with frontmatter');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'and the frontmatter is closed');
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && !line.startsWith(' ')) {
      fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
    }
  }
  return fields;
}

function testTheSkillMeetsTheFormat(): void {
  const files = skillFiles('9.9.9');
  const skill = files.get('SKILL.md');
  assert.ok(skill, 'there is a SKILL.md');

  const fields = frontmatter(skill);
  assert.equal(fields['name'], SKILL_NAME, 'the name matches the directory, as the format requires');
  assert.match(fields['name'] ?? '', /^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase, no leading or doubled hyphen');
  assert.ok((fields['name'] ?? '').length <= 64, 'the name is within 64 characters');

  const description = fields['description'] ?? '';
  assert.ok(description.length > 0, 'a description is required');
  assert.ok(
    description.length <= 1024,
    `the description is within 1024 characters, not ${description.length}`,
  );
  assert.match(description, /\bUse\b/, 'and it says when to use the skill, not only what it does');

  // Progressive disclosure only pays if the entry file stays small: it is loaded whole on any task
  // that matches, while the references are read when they are needed.
  const lines = skill.split('\n').length;
  assert.ok(lines < 500, `SKILL.md is ${lines} lines, and the format asks for under 500`);

  // A blank line between two bullets ends the list and starts another, which reads as two
  // unrelated lists to anything that renders markdown. One got in here by editing around a
  // bullet, and it is invisible in the source.
  const rows = skill.split('\n');
  for (const [index, line] of rows.entries()) {
    if (line.trim() !== '' || !rows[index - 1]?.startsWith('- ') || !rows[index + 1]?.startsWith('- ')) {
      continue;
    }
    assert.fail(`a blank line splits the list at line ${index + 1}: ${rows[index - 1]}`);
  }

  // The project directory is the one you are standing in, so a command here should not carry a
  // placeholder for it.
  assert.doesNotMatch(skill, /<project>/, 'no command in the skill should ask for a path to fill in');
}

function testTheReferenceIsTheServersOwnToolList(): void {
  const reference = skillFiles('9.9.9').get(join('references', 'tools.md'));
  assert.ok(reference, 'the tool reference ships with the skill');
  for (const tool of TOOL_SPECS) {
    assert.ok(reference.includes(`## ${tool.name}`), `${tool.name} is in the reference`);
  }
  assert.ok(
    reference.includes(String(TOOL_SPECS.length)),
    'and it counts the tools rather than stating a number that can rot',
  );
}

/**
 * The shared directory always, and a harness's own only when it needs one. Claude Code, Kiro and
 * Cline do not read `.agents/skills`, so a skill written only there would never be seen by them.
 */
function testItLandsWhereTheChosenHarnessesLook(): void {
  const root = project();
  try {
    const shared = join(root, SHARED_SKILLS, SKILL_NAME);
    const nothing = skillDirectories([], root, existsSync);
    assert.deepEqual(nothing, [shared], 'with no harness at all it still writes the shared directory');

    const claude = harnessById('claude-code');
    assert.ok(claude?.skills && !claude.skills.shared, 'Claude Code is one that does not read shared');
    assert.deepEqual(
      skillDirectories([claude], root, existsSync),
      [shared, join(root, claude.skills.dir, SKILL_NAME)],
      'so it gets its own copy',
    );

    const cursor = harnessById('cursor');
    assert.ok(cursor?.skills?.shared, 'Cursor is one that does read shared');
    assert.deepEqual(
      skillDirectories([cursor], root, existsSync),
      [shared],
      'so the shared directory is the whole answer',
    );

    // Unless this project already keeps skills there, which is where its author will look.
    mkdirSync(join(root, cursor.skills.dir), { recursive: true });
    assert.deepEqual(skillDirectories([cursor], root, existsSync), [
      shared,
      join(root, cursor.skills.dir, SKILL_NAME),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testEveryHarnessThatNeedsItsOwnDirectoryHasOne(): void {
  const alone = HARNESSES.filter((harness) => harness.skills !== undefined && !harness.skills.shared);
  assert.ok(alone.length > 0, 'some harnesses read only their own directory, or this proves nothing');
  for (const harness of alone) {
    assert.ok(
      (harness.skills?.dir ?? '').endsWith('skills'),
      `${harness.id} names a skills directory, not something else`,
    );
  }
}

/** A reference left over from an older version describes a server nobody is running. */
function testRewritingLeavesNothingStaleBehind(): void {
  const root = project();
  try {
    const [directory] = skillDirectories([], root, existsSync);
    assert.ok(directory);

    assert.deepEqual(writeSkill([directory], '9.9.9'), [{ path: directory, replaced: false }]);
    const stale = join(directory, 'references', 'gone.md');
    writeFileSync(stale, 'a tool that no longer exists\n', 'utf8');

    assert.deepEqual(writeSkill([directory], '9.9.10'), [{ path: directory, replaced: true }]);
    assert.equal(existsSync(stale), false, 'the file from the older version is gone');
    assert.match(
      readFileSync(join(directory, 'SKILL.md'), 'utf8'),
      /9\.9\.10/,
      'and the version it records is the new one',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Uninstalling has to leave the project as it found it. The shared directory is one gdharness
 * creates, so its husk goes too; a harness's own directory is that harness's, and stays.
 */
function testRemovingTakesOurDirectoriesAndNobodyElses(): void {
  const root = project();
  try {
    const claude = harnessById('claude-code');
    assert.ok(claude?.skills);
    const directories = skillDirectories([claude], root, existsSync);
    writeSkill(directories, '9.9.9');
    assert.deepEqual([...removeSkill(directories, root)].sort(), [...directories].sort());

    assert.equal(existsSync(join(root, '.agents')), false, 'the directory gdharness made is gone');
    assert.equal(
      existsSync(join(root, '.claude')),
      true,
      'the harness own directory stays, because it is theirs rather than ours',
    );
    assert.equal(
      existsSync(join(root, claude.skills.dir)),
      false,
      'but the empty skills folder inside it does not',
    );

    assert.deepEqual(removeSkill(directories, root), [], 'removing twice reports nothing the second time');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A skills directory holding somebody else's skill is not ours to tidy away. */
function testAnotherSkillBesideOursSurvives(): void {
  const root = project();
  try {
    const directories = skillDirectories([], root, existsSync);
    writeSkill(directories, '9.9.9');
    const theirs = join(root, SHARED_SKILLS, 'their-skill');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'SKILL.md'), '---\nname: their-skill\ndescription: theirs\n---\n', 'utf8');

    removeSkill(directories, root);
    assert.equal(existsSync(theirs), true, 'their skill is untouched');
    assert.equal(existsSync(join(root, SHARED_SKILLS)), true, 'and the directory holding it stays');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TESTS = [
  testTheSkillMeetsTheFormat,
  testTheReferenceIsTheServersOwnToolList,
  testItLandsWhereTheChosenHarnessesLook,
  testEveryHarnessThatNeedsItsOwnDirectoryHasOne,
  testRewritingLeavesNothingStaleBehind,
  testRemovingTakesOurDirectoriesAndNobodyElses,
  testAnotherSkillBesideOursSurvives,
];

for (const test of TESTS) {
  test();
}

console.log(`skill tests passed: ${TOOL_SPECS.length} tools in the reference`);
