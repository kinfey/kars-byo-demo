import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputBudget, DEFAULT_OUTPUT_LIMITS, runtimeOutputLimits } from '../runtime/output-limits.mjs';

test('runtime output limits separate structured tool events from assistant text', () => {
  const limits = {
    assistant: 10,
    structured: 30,
    event: 20,
    diagnostic: 15,
  };
  const budget = createOutputBudget('Claude Code CLI', limits);
  budget.addStructured('x'.repeat(12));
  budget.addStructured('x'.repeat(12));
  budget.checkEvent('x'.repeat(20));
  budget.addAssistant('12345');
  budget.addAssistant('67890');
  assert.throws(() => budget.addAssistant('x'), /assistant response exceeded 4 MiB/);
  assert.throws(() => budget.addStructured('x'.repeat(7)), /structured output exceeded/);
});

test('runtime output limits bound individual events and stderr independently', () => {
  const budget = createOutputBudget('Claude Code CLI', {
    assistant: 100,
    structured: 100,
    event: 10,
    diagnostic: 10,
  });
  assert.throws(() => budget.checkEvent('x'.repeat(11)), /structured event exceeded/);
  budget.addDiagnostic('x'.repeat(10));
  assert.throws(() => budget.addDiagnostic('x'), /diagnostic output exceeded/);
});

test('runtime structured output defaults to 64 MiB and validates overrides', () => {
  assert.equal(DEFAULT_OUTPUT_LIMITS.structured, 64 * 1024 * 1024);
  assert.equal(runtimeOutputLimits({}).structured, 64 * 1024 * 1024);
  const budget = createOutputBudget('Claude Code CLI');
  for (let index = 0; index < 5; index += 1) budget.addStructured('x'.repeat(1024 * 1024));
  budget.addAssistant('done');
  assert.equal(runtimeOutputLimits({ CLI_STRUCTURED_OUTPUT_LIMIT_BYTES: '134217728' }).structured, 128 * 1024 * 1024);
  assert.throws(() => runtimeOutputLimits({ CLI_STRUCTURED_OUTPUT_LIMIT_BYTES: '1' }), /CLI_STRUCTURED_OUTPUT_LIMIT_BYTES/);
});
