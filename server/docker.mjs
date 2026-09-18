import { spawn } from 'node:child_process';
import { RUNTIMES } from './config.mjs';

export function command(args, { onData, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', data => { output = (output + data).slice(-2_000_000); onData?.(data.toString()); });
    child.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-100000); onData?.(data.toString()); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`Docker ${args[0]} failed${signal ? ` (${signal})` : ''}: ${errorOutput || output || `exit ${code}`}`));
    });
  });
}

export const containerName = id => `kars-byo-${id}`;
export const volumeName = id => `kars-byo-workspace-${id}`;

export async function inspect(id) {
  const output = await command(['ps', '-a', '--filter', `name=^/${containerName(id)}$`, '--format', '{{json .}}']);
  if (!output) return { status: 'missing' };
  const item = JSON.parse(output);
  if (item.State !== 'running') return { status: 'stopped' };
  const info = JSON.parse(await command(['inspect', containerName(id)]))[0];
  const binding = info.NetworkSettings.Ports['8080/tcp']?.[0];
  return { status: 'running', port: binding?.HostPort };
}

export async function removeContainer(id) {
  const state = await inspect(id);
  if (state.status !== 'missing') await command(['rm', '-f', containerName(id)]);
}

export async function startContainer(config, configPath) {
  await removeContainer(config.id);
  await command([
    'run', '-d', '--name', containerName(config.id), '--label', 'org.kars.byo-studio=local',
    '--init', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=536870912,mode=1777',
    '--mount', `type=volume,src=${volumeName(config.id)},dst=/sandbox`,
    '--mount', `type=bind,src=${configPath},dst=/run/agent/config.json,readonly`,
    '-e', `SANDBOX_NAME=${config.id}`, '-e', 'KARS_RUNTIME_CONTRACT_VERSION=v1',
    '-p', '127.0.0.1::8080', RUNTIMES[config.runtime].image,
  ]);
  const state = await inspect(config.id);
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(1500) }).catch(error => {
        if (error.name === 'TimeoutError' || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) return null;
        throw error;
      });
      if (response?.ok) return state;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Runtime health endpoint did not become ready');
  } catch (error) {
    const logs = await command(['logs', '--tail', '30', containerName(config.id)]);
    await removeContainer(config.id);
    throw new Error(`${error.message}\n${logs}`);
  }
}
