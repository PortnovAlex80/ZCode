import { parseV4VisibleSlashCommand } from "./slashCommands.js";

/** Freeze only the body that the native send path will admit as text. */
export function documentFirstInputBody(
  ...args: Parameters<typeof parseV4VisibleSlashCommand>
): string | undefined {
  const command = parseV4VisibleSlashCommand(...args);
  if (command === null) return args[0];
  return command.kind === "planShortcut" && command.task ? command.task : undefined;
}
