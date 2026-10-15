/** 搜索输入不是打开路径：只匹配当前服务给出的条目，绝不跨项目读文件。 */
export function documentSearchQuery(query: string, workspaceRoot?: string): string {
  let value = query
    .trim()
    .replace(/^["'“]|["'”]$/g, "")
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  const root = workspaceRoot
    ?.replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (root) {
    const prefix = `${root}/`;
    const projectPrefix = `${root.split("/").at(-1)}/`;
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) value = value.slice(prefix.length);
    else if (value.toLowerCase().startsWith(projectPrefix.toLowerCase()))
      value = value.slice(projectPrefix.length);
  }
  return value.toLowerCase().replaceAll("ё", "е");
}

export function findDocuments<T extends { display: string; name: string }>(
  entries: readonly T[],
  query: string,
  workspaceRoot?: string,
): T[] {
  const normalized = documentSearchQuery(query, workspaceRoot);
  if (!normalized) return [...entries];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const fold = (value: string) => value.toLowerCase().replaceAll("ё", "е");
  const score = (entry: T) => {
    const name = fold(entry.name);
    return name === normalized
      ? 0
      : name.startsWith(normalized)
        ? 1
        : terms.every((term) => name.includes(term))
          ? 2
          : 3;
  };
  return entries
    .filter((entry) => terms.every((term) => fold(entry.display).includes(term)))
    .sort((left, right) => score(left) - score(right));
}
