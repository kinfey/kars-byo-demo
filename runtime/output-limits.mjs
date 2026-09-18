const MIB = 1024 * 1024;

export const DEFAULT_OUTPUT_LIMITS = Object.freeze({
  assistant: 4 * MIB,
  structured: 64 * MIB,
  event: 16 * MIB,
  diagnostic: 16 * MIB,
});

function byteLimit(name, value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function runtimeOutputLimits(env = process.env) {
  return {
    assistant: DEFAULT_OUTPUT_LIMITS.assistant,
    structured: byteLimit(
      'CLI_STRUCTURED_OUTPUT_LIMIT_BYTES',
      env.CLI_STRUCTURED_OUTPUT_LIMIT_BYTES,
      DEFAULT_OUTPUT_LIMITS.structured,
      4 * MIB,
      256 * MIB,
    ),
    event: byteLimit(
      'CLI_EVENT_LIMIT_BYTES',
      env.CLI_EVENT_LIMIT_BYTES,
      DEFAULT_OUTPUT_LIMITS.event,
      MIB,
      64 * MIB,
    ),
    diagnostic: byteLimit(
      'CLI_DIAGNOSTIC_LIMIT_BYTES',
      env.CLI_DIAGNOSTIC_LIMIT_BYTES,
      DEFAULT_OUTPUT_LIMITS.diagnostic,
      MIB,
      64 * MIB,
    ),
  };
}

export function createOutputBudget(cliName, limits = runtimeOutputLimits()) {
  let assistant = 0;
  let structured = 0;
  let diagnostic = 0;
  const add = (kind, bytes, limit, message) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Output byte count is invalid');
    const next = kind === 'assistant' ? assistant + bytes
      : kind === 'structured' ? structured + bytes
        : diagnostic + bytes;
    if (next > limit) throw new Error(message);
    if (kind === 'assistant') assistant = next;
    else if (kind === 'structured') structured = next;
    else diagnostic = next;
  };
  return {
    addAssistant(text) {
      add('assistant', Buffer.byteLength(text), limits.assistant, `${cliName} assistant response exceeded 4 MiB`);
    },
    addStructured(chunk) {
      add('structured', Buffer.byteLength(chunk), limits.structured, `${cliName} structured output exceeded ${limits.structured / MIB} MiB`);
    },
    checkEvent(line) {
      if (Buffer.byteLength(line) > limits.event) throw new Error(`${cliName} structured event exceeded ${limits.event / MIB} MiB`);
    },
    addDiagnostic(chunk) {
      add('diagnostic', Buffer.byteLength(chunk), limits.diagnostic, `${cliName} diagnostic output exceeded ${limits.diagnostic / MIB} MiB`);
    },
  };
}
