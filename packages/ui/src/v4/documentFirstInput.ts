import { parseV4VisibleSlashCommand } from "./slashCommands.js";

/** Freeze only the body that the native send path will admit as text. */
export function documentFirstInputBody(
  ...args: Parameters<typeof parseV4VisibleSlashCommand>
): string | undefined {
  const command = parseV4VisibleSlashCommand(...args);
  if (command === null) return args[0];
  // planShortcut 在上游 3.16.2 已随 goal 命令改版删除；可见斜杠命令一律不再作为首条正文。
  return undefined;
}
