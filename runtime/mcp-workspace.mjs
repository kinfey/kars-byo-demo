import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_READ = 128 * 1024;

export function createWorkspaceServer(root = '/sandbox/agent') {
  async function confined(value = '.') {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid workspace path');
    const base = await realpath(root);
    const target = await realpath(path.resolve(base, value));
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Path is outside the workspace');
    return target;
  }
  return async function dispatch(request) {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    if (request.id === undefined) return null;
    const response = { jsonrpc: '2.0', id: request.id };
    try {
      if (request.method === 'initialize') {
        response.result = {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'kars-workspace', version: '1.0.0' },
        };
      } else if (request.method === 'ping') {
        response.result = {};
      } else if (request.method === 'tools/list') {
        response.result = { tools: [
          { name: 'workspace_list', description: 'List files in the agent workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
          { name: 'workspace_read', description: 'Read a UTF-8 file in the agent workspace (128 KiB maximum).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
        ] };
      } else if (request.method === 'tools/call') {
        try {
          const { name, arguments: args = {} } = request.params ?? {};
          let text;
          if (name === 'workspace_list') {
            const entries = await readdir(await confined(args.path), { withFileTypes: true });
            text = entries.slice(0, 1000).map(e => `${e.name}${e.isDirectory() ? '/' : e.isSymbolicLink() ? ' (symlink)' : ''}`).join('\n');
          } else if (name === 'workspace_read') {
            if (typeof args.path !== 'string') throw new Error('path is required');
            const filename = await confined(args.path);
            const info = await stat(filename);
            if (!info.isFile() || info.size > MAX_READ) throw new Error('Expected a file of at most 128 KiB');
            text = await readFile(filename, 'utf8');
            if (Buffer.byteLength(text) > MAX_READ) throw new Error('File exceeds read limit');
          } else throw new Error('Unknown workspace tool');
          response.result = { content: [{ type: 'text', text }] };
        } catch {
          response.result = { isError: true, content: [{ type: 'text', text: 'Workspace operation refused: invalid path, inaccessible file, or size limit.' }] };
        }
      } else response.error = { code: -32601, message: 'Method not found' };
    } catch {
      response.error = { code: -32603, message: 'Workspace server error' };
    }
    return response;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dispatch = createWorkspaceServer();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let result;
    try {
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error('Oversized request');
      result = await dispatch(JSON.parse(line));
    } catch {
      result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  }
}
