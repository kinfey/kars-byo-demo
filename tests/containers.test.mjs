import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from '../server/config.mjs';
import { startContainer, removeContainer, command, volumeName, containerName } from '../server/docker.mjs';

test('all three real CLI images run non-root with readonly rootfs and authenticated HTTP', {
  skip: process.env.RUN_DOCKER_TESTS !== '1', timeout: 180000,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'byo-containers-test-'));
  try {
    for (const runtime of ['claude', 'copilot', 'codex']) {
      const config = { ...normalizeConfig({ name: `Smoke ${runtime}`, runtime }), runtimeToken: randomBytes(32).toString('hex') };
      const file = path.join(dir, `${runtime}.json`);
      await writeFile(file, JSON.stringify(config), { mode: 0o644 });
      try {
        const state = await startContainer(config, file);
        assert.equal(state.status, 'running');
        const health = await fetch(`http://127.0.0.1:${state.port}/healthz`);
        assert.equal(health.status, 200);
        const unauthorized = await fetch(`http://127.0.0.1:${state.port}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello', history: [] }),
        });
        assert.equal(unauthorized.status, 401);
        const info = JSON.parse(await command(['inspect', containerName(config.id)]))[0];
        assert.equal(info.Config.User, '1000:1000');
        assert.equal(info.HostConfig.ReadonlyRootfs, true);
        assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
        const binary = runtime === 'claude' ? 'claude' : runtime;
        const version = await command(['exec', containerName(config.id), binary, '--version']);
        assert.ok(version.length > 0);
      } finally {
        await removeContainer(config.id);
        const volumes = await command(['volume', 'ls', '--filter', `name=^${volumeName(config.id)}$`, '--format', '{{.Name}}']);
        if (volumes) await command(['volume', 'rm', volumeName(config.id)]);
      }
    }
  } finally { await rm(dir, { recursive: true }); }
});
