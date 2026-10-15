/** Host may request only the official SIWC authorization page; never log its query. */
export async function launchChatGptBrowser(
  url: string,
  openExternal: (url: string) => Promise<void>,
): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://auth.openai.com" ||
      parsed.pathname !== "/api/accounts/authorize" ||
      parsed.username ||
      parsed.password
    )
      return false;
    await openExternal(url);
    return true;
  } catch {
    return false;
  }
}
