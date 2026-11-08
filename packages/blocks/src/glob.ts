/** Whether the path contains mask characters. */
export const hasGlob = (p: string): boolean => /[*?[]/.test(p);

/**
 * Mask -> RegExp over relative paths with `/`. Supported:
 * `*` any characters except `/`, `?` one character except `/`, `[abc]` / `[!abc]` a set,
 * `**` any characters including the slash (`**` followed by a slash means zero or more directories).
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        let body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Directory up to the first mask character: the traversal starts from it. */
export function globBase(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (hasGlob(p)) break;
    fixed.push(p);
  }
  return fixed.join("/");
}
