const PREFIX = "zcode-popout-open:v1:";
type StoragePort = Pick<Storage, "getItem" | "setItem">;

export function readPopoutOpenIntent(key: string, storage?: StoragePort): boolean {
  try {
    return (storage ?? localStorage).getItem(PREFIX + key) === "true";
  } catch {
    return false;
  }
}

export function writePopoutOpenIntent(key: string, open: boolean, storage?: StoragePort): void {
  try {
    (storage ?? localStorage).setItem(PREFIX + key, String(open));
  } catch {
    /* A storage failure must not prevent returning the live window. */
  }
}
