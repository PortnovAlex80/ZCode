export function selectionCommand(readSelection, showPane, reportError, intent) {
  return async (event) => {
    try {
      await readSelection(intent);
      await showPane();
    } catch {
      reportError("Word не смог открыть обсуждение. Повторите команду.");
    } finally {
      event.completed();
    }
  };
}
