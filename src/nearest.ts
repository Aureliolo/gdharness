/**
 * The names a refusal offers for one that is not there, read the way the engine reads them.
 *
 * The same measure as Godot's `String.similarity`, which the operations' refusals use through
 * `GdhRead.nearest`, so a misspelt path is offered the same files whichever half refuses it.
 */

/** Godot's `String.similarity`: twice the shared character pairs over all of them. */
function similarity(one: string, other: string): number {
  if (one === other) {
    return 1;
  }
  if (one.length < 2 || other.length < 2) {
    return 0;
  }
  const pairs = (text: string): string[] =>
    Array.from({ length: text.length - 1 }, (_, at) => text.slice(at, at + 2));
  const ones = pairs(one);
  const others = pairs(other);
  const shared = ones.filter((pair) => others.includes(pair)).length;
  return (2 * shared) / (ones.length + others.length);
}

/** How many names a refusal lists at most, near or not, as `NAMED_CHILDREN` does. */
const LISTED_FILES = 12;

/**
 * [param said], the refusal for [param wanted], a res:// path nothing is at, with those of
 * [param files] (res:// paths of its extension) named nearest it, or every one when there are few
 * and none is near. Those of [param beside] (res:// paths of the files in its folder) named as it is
 * with another extension come first, since a misspelt extension has no file of its own extension to
 * be near. The wording is `GdhFileWalk.with_nearest_files`'s.
 */
export function withNearestFiles(
  said: string,
  wanted: string,
  files: readonly string[],
  beside: readonly string[],
): string {
  const stem = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[^.]*$/, '');
  // One the refusal names is the file it refuses, as a script given for a scene is. Word by word,
  // since res://brain.gd is inside res://brain.gdd.
  const named = said.split(/[\s,;]+/).map((word) => word.replace(/[.:]+$/, ''));
  const namesakes = beside
    .filter((file) => file !== wanted && stem(file) === stem(wanted) && !named.includes(file))
    .toSorted();
  if (namesakes.length > 0) {
    const alone = namesakes.length === 1;
    return `${said}. ${namesakes.join(', ')} ${alone ? 'has' : 'have'} that name with ${alone ? 'another extension' : 'other extensions'}.`;
  }
  const extension = /\.([^./]+)$/.exec(wanted)?.[1];
  if (extension === undefined) {
    return said;
  }
  if (files.length === 0) {
    return `${said}. The project holds no .${extension} file.`;
  }
  const close = nearest(
    stem(wanted),
    files.map((file) => stem(file)),
  );
  const offered = files.filter((file) => close.includes(stem(file)));
  if (offered.length > 0) {
    return `${said}. The nearest .${extension} ${offered.length === 1 ? 'file is' : 'files are'} ${offered.join(', ')}.`;
  }
  if (files.length <= LISTED_FILES) {
    return `${said}. The project's .${extension} files are ${files.join(', ')}.`;
  }
  return `${said}. None of the project's ${files.length} .${extension} files is named like it.`;
}

/**
 * Three of [param names] closest to [param word], closest first, and every further name that only
 * adds to the word, since cutting at three named three corners of `corner_radius` and left out the
 * fourth, up to [constant LISTED_FILES] in all. Case is ignored, and equally near names keep the
 * order given. The engine's `GdhRead.nearest` keeps the same names.
 */
export function nearest(word: string, names: readonly string[]): string[] {
  const wanted = word.toLowerCase();
  const score = (name: string): number => similarity(name.toLowerCase(), wanted);
  const close = names
    .filter((name) => score(name) >= 0.5)
    .toSorted((one, other) => score(other) - score(one));
  const extending = close.slice(3).filter((name) => name.toLowerCase().startsWith(wanted));
  return [...close.slice(0, 3), ...extending].slice(0, LISTED_FILES);
}
