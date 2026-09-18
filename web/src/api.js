import { getLocale, translate } from './i18n.js';

function apiError(key, params) {
  const error = new Error(translate(getLocale(), key, params));
  error.i18nKey = key;
  error.i18nParams = params;
  return error;
}

export async function api(path, options = {}) {
  const { rawBody = false, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(path, {
      ...requestOptions,
      headers: {
        ...(requestOptions.method ? { 'Content-Type': 'application/json' } : {}),
        ...(requestOptions.headers || {}),
        'Accept-Language': getLocale(),
      },
      ...(requestOptions.body !== undefined ? { body: rawBody ? requestOptions.body : JSON.stringify(requestOptions.body) } : {}),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw apiError('api.errors.networkFailed');
  }
  if (!response.ok) {
    const text = await response.text();
    let message = translate(getLocale(), 'api.errors.httpFailed', { status: response.status });
    let translations;
    try {
      const payload = JSON.parse(text);
      message = payload.error || message;
      translations = payload.translations;
    } catch {
      message = `${message} ${translate(getLocale(), 'api.errors.invalidJson')}`;
    }
    const error = new Error(message);
    error.localizedMessages = translations;
    throw error;
  }
  return response;
}

export async function json(path, options) {
  return (await api(path, options)).json();
}

export async function stream(path, body, onEvent, signal) {
  const response = await api(path, { method: 'POST', body, signal });
  if (!response.body) throw apiError('api.errors.streamUnsupported');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  function receive(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw apiError('api.errors.streamInvalid');
    }
    if (event.type === 'error') {
      const error = new Error(event.message || translate(getLocale(), 'api.errors.streamError'));
      error.localizedMessages = event.translations;
      throw error;
    }
    if (event.type === 'done') completed = true;
    onEvent(event);
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        receive(line);
        if (completed) break;
      }
      if (done) {
        if (!completed) receive(buffer);
        break;
      }
    }
    if (!completed) throw apiError('api.errors.connectionClosed');
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
