import http from 'node:http';
import { ProxyAgent } from 'undici';

const BODY_LIMIT = 8 * 1024 * 1024;

function restoreNamespaces(value, namespaces) {
  if (Array.isArray(value)) return value.map(item => restoreNamespaces(item, namespaces));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreNamespaces(item, namespaces)]));
  if (result.type === 'function_call' && !result.namespace && namespaces.has(result.name)) {
    result.namespace = namespaces.get(result.name);
  }
  return result;
}

function transformEventStream(raw, namespaces) {
  return raw.split(/(?<=\n)/).map(line => {
    if (!line.startsWith('data:')) return line;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return line;
    try { return `data: ${JSON.stringify(restoreNamespaces(JSON.parse(data), namespaces))}\n`; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return line;
    }
  }).join('');
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('Codex provider request exceeds 8 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startCodexCompatibilityProxy({ upstream, credential }) {
  const base = new URL(upstream);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Codex compatibility upstream');
  const dispatcher = ['127.0.0.1', 'localhost'].includes(base.hostname)
    ? undefined
    : new ProxyAgent(process.env.HTTPS_PROXY || 'http://127.0.0.1:8444');
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) {
        res.writeHead(404).end();
        return;
      }
      const raw = await body(req);
      const request = JSON.parse(raw.toString('utf8'));
      const namespaces = new Map((request.tools || [])
        .filter(tool => tool?.type === 'function' && tool.namespace && tool.name)
        .map(tool => [tool.name, tool.namespace]));
      const target = new URL(base);
      const requested = new URL(req.url, 'http://127.0.0.1');
      target.pathname = `${base.pathname.replace(/\/+$/, '')}${requested.pathname.slice('/v1'.length)}`;
      target.search = requested.search;
      const azure = base.hostname.toLowerCase().endsWith('.openai.azure.com');
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: req.headers.accept || 'text/event-stream',
          ...(azure ? { 'api-key': credential } : { Authorization: `Bearer ${credential}` }),
        },
        body: raw,
        ...(dispatcher ? { dispatcher } : {}),
      });
      const responseBody = await response.text();
      const contentType = response.headers.get('content-type') || 'application/json';
      let output = responseBody;
      if (namespaces.size) {
        if (contentType.includes('text/event-stream')) output = transformEventStream(responseBody, namespaces);
        else {
          try { output = JSON.stringify(restoreNamespaces(JSON.parse(responseBody), namespaces)); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
      }
      res.writeHead(response.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(output);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (dispatcher) await dispatcher.close();
    },
  };
}
