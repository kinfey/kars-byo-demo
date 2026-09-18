import { mkdir, readFile, writeFile, rename, chmod, unlink, rmdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeProvider, requireId, RUNTIMES } from './config.mjs';

export class Store {
  constructor(root) { this.root = root; }
  directory(id) { return path.join(this.root, requireId(id)); }
  sessionDirectory(id) { return path.join(this.root, '.sessions', requireId(id)); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, '.sessions'), { recursive: true, mode: 0o700 });
    try { await chmod(this.root, 0o700); }
    catch (error) {
      if (error.code !== 'EPERM' || process.env.STORE_MODELESS !== '1') throw error;
    }
  }
  async list() {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.root, { withFileTypes: true });
    const result = [];
    for (const entry of entries) if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)) result.push(await this.get(entry.name));
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id) { return JSON.parse(await readFile(path.join(this.directory(id), 'config.json'), 'utf8')); }
  async save(config) {
    const dir = this.directory(config.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.atomic(path.join(dir, 'config.json'), config);
  }
  skillArchiveDirectory(id) { return path.join(this.directory(id), 'skill-archives'); }
  skillArchivePath(id, name) { return path.join(this.skillArchiveDirectory(id), `${name}.zip`); }
  skillDirectory(id, name) { return path.join(this.directory(id), 'skills', name); }
  async saveSkillArchive(id, name, archive) {
    const directory = this.skillArchiveDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = this.skillArchivePath(id, name);
    await writeFile(`${file}.tmp`, archive, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async skillArchive(id, name) { return readFile(this.skillArchivePath(id, name)); }
  async deleteSkillArchive(id, name) {
    try { await unlink(this.skillArchivePath(id, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(this.skillDirectory(id, name), { recursive: true, force: true });
  }
  async deleteAgent(id) { await rm(this.directory(id), { recursive: true, force: false }); }
  async atomic(file, value) {
    await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async messages(id) {
    try { return JSON.parse(await readFile(path.join(this.directory(id), 'messages.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async saveMessages(id, messages) { await this.atomic(path.join(this.directory(id), 'messages.json'), messages); }
  async sessions() {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.join(this.root, '.sessions'), { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      sessions.push(JSON.parse(await readFile(path.join(this.sessionDirectory(entry.name), 'session.json'), 'utf8')));
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async session(id) { return JSON.parse(await readFile(path.join(this.sessionDirectory(id), 'session.json'), 'utf8')); }
  async saveSession(session) {
    const dir = this.sessionDirectory(session.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.atomic(path.join(dir, 'session.json'), session);
  }
  async sessionMessages(id) {
    try { return JSON.parse(await readFile(path.join(this.sessionDirectory(id), 'messages.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async saveSessionMessages(id, messages) { await this.atomic(path.join(this.sessionDirectory(id), 'messages.json'), messages); }
  async deleteSession(id) {
    const directory = this.sessionDirectory(id);
    for (const name of ['messages.json', 'session.json']) {
      try { await unlink(path.join(directory, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rmdir(directory);
  }
  async providers() {
    try { return JSON.parse(await readFile(path.join(this.root, 'providers.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async saveProviders(providers) { await this.atomic(path.join(this.root, 'providers.json'), providers); }
  async migrateLegacyProviders() {
    const providers = await this.providers();
    const agents = await this.list();
    let changed = false;
    for (const runtime of Object.keys(RUNTIMES)) {
      if (providers[runtime]) continue;
      const candidates = agents.filter(agent => agent.runtime === runtime && agent.credential);
      const unique = new Map(candidates.map(agent => [
        JSON.stringify({ model: agent.model, baseUrl: agent.baseUrl, credential: agent.credential }),
        agent,
      ]));
      if (unique.size !== 1) continue;
      providers[runtime] = normalizeProvider(unique.values().next().value, runtime);
      changed = true;
      for (const agent of candidates) await this.save({ ...agent, credential: '' });
    }
    if (changed) await this.saveProviders(providers);
    return providers;
  }
  async migrateLegacySessions() {
    const agents = await this.list();
    const sessions = await this.sessions();
    for (const agent of agents) {
      const messages = await this.messages(agent.id);
      if (sessions.some(session => session.legacyAgentId === agent.id)) {
        if (messages.length) await this.saveMessages(agent.id, []);
        continue;
      }
      if (!messages.length) continue;
      const migrated = messages.map(message => ({ ...message, agentId: agent.id, agentName: agent.name }));
      const firstUser = migrated.find(message => message.role === 'user' && message.content);
      const createdAt = migrated[0]?.createdAt || agent.createdAt;
      const updatedAt = migrated.at(-1)?.createdAt || createdAt;
      const session = {
        id: randomUUID(),
        title: firstUser?.content?.slice(0, 60) || `${agent.name} history`,
        currentAgentId: agent.id,
        legacyAgentId: agent.id,
        createdAt,
        updatedAt,
      };
      await this.saveSession(session);
      await this.saveSessionMessages(session.id, migrated);
      await this.saveMessages(agent.id, []);
      sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
