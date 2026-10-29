/** Есть ли в пути символы маски. */
export const hasGlob = (p: string): boolean => /[*?[]/.test(p);

/**
 * Маска → RegExp по относительным путям с `/`. Поддерживается:
 * `*` — любые символы кроме `/`, `?` — один символ кроме `/`, `[abc]` / `[!abc]` — набор,
 * `**` — любые символы включая слэш (`**` и слэш подряд — ноль и более каталогов).
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

/** Каталог до первого символа маски: с него начинается обход. */
export function globBase(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (hasGlob(p)) break;
    fixed.push(p);
  }
  return fixed.join("/");
}
