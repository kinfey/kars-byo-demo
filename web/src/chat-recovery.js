export function isRecoverableChatError(error) {
  return error?.i18nKey === 'api.errors.networkFailed' ||
    error?.i18nKey === 'api.errors.connectionClosed';
}

export async function recoverChatHistory(loadHistory, {
  priorMessageCount,
  signal,
  attempts = 1200,
  intervalMs = 3000,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) return null;
    try {
      const history = await loadHistory();
      const completion = history.slice(priorMessageCount + 1)
        .find(message => message.role === 'assistant' || message.role === 'error');
      if (completion) return history;
    } catch {
      // A transient outage can also affect polling; retry until the runtime completes.
    }
    await wait(intervalMs);
  }
  return null;
}
