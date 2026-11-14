/**
 * A heading's own link, from its words: what a reader copies to point somebody at a section. It
 * follows GitHub's rule, so a link that works in GitHub's rendering and in markdownlint works on the
 * site too: lowercase, every character but a letter, mark, number, underscore, space or hyphen
 * dropped, then each space made a hyphen.
 */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}
