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

/** How many files a refusal lists when none is near the one asked for, as `NAMED_CHILDREN` does. */
const LISTED_FILES = 12;

/**
 * [param said], the refusal for [param wanted], a res:// path nothing is at, with those of
 * [param files] (res:// paths of its extension) named nearest it, or every one when there are few
 * and none is near. The wording is `GdhFileWalk.with_nearest_files`'s.
 */
export function withNearestFiles(said: string, wanted: string, files: readonly string[]): string {
  const extension = /\.([^./]+)$/.exec(wanted)?.[1];
  if (extension === undefined) {
    return said;
  }
  if (files.length === 0) {
    return `${said}. The project holds no .${extension} file.`;
  }
  const stem = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[^.]*$/, '');
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

/** Up to three of [param names] closest to [param word], closest first, ignoring case. */
function nearest(word: string, names: readonly string[]): string[] {
  const wanted = word.toLowerCase();
  const score = (name: string): number => similarity(name.toLowerCase(), wanted);
  return names
    .filter((name) => score(name) >= 0.5)
    .sort((one, other) => score(other) - score(one))
    .slice(0, 3);
}
