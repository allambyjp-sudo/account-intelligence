/** Lines on the new version of a careers page that weren't on the old one: usually new role titles. */
export function addedLines(previous: string, current: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const before = new Set(previous.split(/\n+/).map(norm).filter(Boolean));
  return current
    .split(/\n+/)
    .map(norm)
    .filter((l) => l.length >= 4 && l.length <= 200 && !before.has(l))
    .slice(0, 40);
}
