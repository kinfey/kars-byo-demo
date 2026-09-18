export const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;

export function agentTimeoutMs(value = process.env.CHAT_TIMEOUT_MS) {
  if (value === undefined || value === '') return DEFAULT_AGENT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 60_000 || timeout > 24 * 60 * 60 * 1000) {
    throw new Error('CHAT_TIMEOUT_MS must be an integer between 60000 and 86400000');
  }
  return timeout;
}
