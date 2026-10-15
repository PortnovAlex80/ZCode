const REQUEST_TIMEOUT_MS = 15_000;

/** Bound HTTP headers and body inside the caller transaction, before persistence. */
export async function withChatGptRequestDeadline<T>(
  load: (signal: AbortSignal) => Promise<T>,
  timeoutError: Error,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // 先完成 deadline，再取消网络；即使自定义 fetch 忽略 signal 也不会挂住登录。
      reject(timeoutError);
      controller.abort(timeoutError);
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => load(controller.signal)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
