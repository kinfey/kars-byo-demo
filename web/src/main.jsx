import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, json, stream } from './api.js';
import { isRecoverableChatError, recoverChatHistory } from './chat-recovery.js';
import { I18nProvider, LanguageSelect, useI18n } from './i18n.jsx';
import { getLocale } from './i18n.js';
import './style.css';
import './portal.css';

const RUNTIMES = [
  { id: 'claude', name: 'Claude', labelKey: 'runtime.claude.label', mark: '✳', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com', descriptionKey: 'runtime.claude.description' },
  { id: 'copilot', name: 'GitHub Copilot CLI', labelKey: 'runtime.copilot.label', mark: '⌘', model: 'gpt-6-astra', baseUrl: '', descriptionKey: 'runtime.copilot.description' },
  { id: 'codex', name: 'Codex', labelKey: 'runtime.codex.label', mark: '>_', model: 'gpt-5.4', baseUrl: 'https://api.openai.com/v1', descriptionKey: 'runtime.codex.description' },
];

function blankForm(runtime = 'claude') {
  const preset = RUNTIMES.find((item) => item.id === runtime);
  return {
    name: '',
    runtime,
    model: preset.model,
    baseUrl: preset.baseUrl,
    credential: '',
    instructions: '',
    tools: false,
    mcpServers: [],
    preservedMcpServers: {},
    skills: [],
  };
}

function agentForm(agent) {
  return {
    ...blankForm(agent.runtime),
    ...agent,
    credential: '',
    mcpServers: Object.entries(agent.mcpServers || {}).filter(([, server]) => server.url).map(([name, server]) => ({
      name,
      endpoint: server.url,
      key: (server.headers?.Authorization || '').replace(/^Bearer\s+/i, ''),
      hasKey: server.hasKey || Boolean(server.headers?.Authorization),
      headers: Object.fromEntries(Object.entries(server.headers || {}).filter(([header]) => header.toLowerCase() !== 'authorization')),
    })),
    preservedMcpServers: Object.fromEntries(Object.entries(agent.mcpServers || {}).filter(([, server]) => !server.url)),
    skills: (agent.skills || []).map((skill) => ({ ...skill, uploaded: true, file: null })),
  };
}

function blankProviders() {
  return Object.fromEntries(RUNTIMES.map((runtime) => [runtime.id, {
    runtime: runtime.id,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    credential: '',
    hasCredential: false,
    configured: false,
  }]));
}

function keyMessage(key, params = {}) {
  return { kind: 'key', key, params };
}

function rawMessage(text, translations) {
  return { kind: 'raw', text, translations };
}

function errorText(error) {
  return error?.message || String(error);
}

function captureError(error) {
  return error?.i18nKey ? keyMessage(error.i18nKey, error.i18nParams) : rawMessage(errorText(error), error?.localizedMessages);
}

function renderMessage(message, t) {
  if (!message) return null;
  if (typeof message === 'string') return message;
  if (message.kind === 'raw') return message.translations?.[getLocale()] || message.text;
  if (message.kind === 'key') return t(message.key, message.params);
  if (message.kind === 'cancel') return t('errors.cancelChat', { message: renderMessage(message.message, t) });
  return null;
}

function renderLines(text) {
  return String(text).split('\n').map((line, index) => (index === 0 ? line : <React.Fragment key={index}><br />{line}</React.Fragment>));
}

function validateMcp(servers) {
  for (const server of servers) {
    try {
      const endpoint = new URL(server.endpoint.trim());
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return keyMessage('errors.validation.mcpEndpoint');
    } catch {
      return keyMessage('errors.validation.mcpEndpoint');
    }
    if (/[\r\n\0]/.test(server.key)) return keyMessage('errors.validation.mcpKey');
  }
  return null;
}

function newMcpServer(servers) {
  const names = new Set(servers.map((server) => server.name));
  let index = 1;
  while (names.has(`mcp_${String(index).padStart(2, '0')}`)) index += 1;
  return { name: `mcp_${String(index).padStart(2, '0')}`, endpoint: '', key: '', headers: {} };
}

function serializeMcpServers(form) {
  const entries = form.mcpServers.map((server) => {
    const headers = { ...(server.headers || {}) };
    if (server.key.trim()) headers.Authorization = `Bearer ${server.key.trim()}`;
    return [server.name.trim(), {
      type: 'http',
      url: server.endpoint.trim(),
      ...(Object.keys(headers).length ? { headers } : {}),
    }];
  });
  return { ...form.preservedMcpServers, ...Object.fromEntries(entries) };
}

function messageScope(scope, message) {
  return { scope, message };
}

function statusText(status, t) {
  if (!status) return t('status.unknown');
  const translated = t(`status.${status}`);
  return translated === `status.${status}` ? status : translated;
}

function runtimeById(id) {
  return RUNTIMES.find((item) => item.id === id);
}

function credentialKey(runtime) {
  return `fields.credential.${runtime}`;
}

function baseUrlKey(runtime) {
  return `fields.baseUrl.${runtime}`;
}

function localizedThemeMode(theme, t) {
  return theme === 'dark' ? t('theme.mode.light') : t('theme.mode.dark');
}

function Icon({ name, size = 18, ...props }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M7 17 17 7M7 7h10v10" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    send: <path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14" />,
    box: <path d="m12 3 9 5v8l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5" />,
    sliders: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
    chat: <path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 8 4 4-4 4M13 16h5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.box}</svg>;
}

function ErrorNotice({ children }) {
  return children ? <div className="notice error" role="alert"><span aria-hidden="true">!</span><div>{children}</div></div> : null;
}

function StatusBadge({ status, cloud = false }) {
  const { t } = useI18n();
  return <span className={`badge ${status === 'running' ? 'success' : ''}`}><span className="dot" />{cloud ? t('status.cloudDev') : statusText(status, t)}</span>;
}

function artifactUrl(agentId, artifact, preview = false) {
  const query = new URLSearchParams({ path: artifact.path });
  if (preview) query.set('preview', '1');
  return `/api/agents/${encodeURIComponent(agentId)}/artifacts?${query}`;
}

function ArtifactCards({ agentId, artifacts, onPreview }) {
  const { t } = useI18n();
  if (!agentId || !artifacts?.length) return null;
  return <div className="artifact-list">
    <div className="artifact-list-title">{t('artifacts.title')}</div>
    {artifacts.map((artifact) => <div className="artifact-card" key={artifact.path}>
      <span className="artifact-icon"><Icon name="box" size={18} /></span>
      <span className="artifact-copy"><strong title={artifact.path}>{artifact.name}</strong><small>{t(`artifacts.type.${artifact.type}`)} · {(artifact.size / 1024).toFixed(1)} KB</small></span>
      <button type="button" className="button small" onClick={() => onPreview({ agentId, artifact })}>{t('artifacts.preview')}</button>
      <a className="button small artifact-download" href={artifactUrl(agentId, artifact)} download>{t('artifacts.download')}</a>
    </div>)}
  </div>;
}

function ArtifactPreview({ value, onClose }) {
  const { t } = useI18n();
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const { agentId, artifact } = value || {};
  const previewUrl = value ? artifactUrl(agentId, artifact, true) : '';
  useEffect(() => {
    setMarkdown('');
    setError('');
    if (!value || artifact.type !== 'markdown') return undefined;
    const controller = new AbortController();
    fetch(previewUrl, { signal: controller.signal, headers: { 'Accept-Language': getLocale() } })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.text();
      })
      .then(setMarkdown)
      .catch((reason) => { if (reason.name !== 'AbortError') setError(t('artifacts.previewFailed')); });
    return () => controller.abort();
  }, [value, artifact?.type, previewUrl, t]);
  if (!value) return null;
  return <>
    <button type="button" className="artifact-preview-backdrop" aria-label={t('artifacts.close')} onClick={onClose} />
    <section className="artifact-preview-modal" role="dialog" aria-modal="true" aria-label={t('artifacts.previewTitle', { name: artifact.name })}>
      <header><div><strong>{artifact.name}</strong><small>{artifact.path}</small></div><div className="inline-actions"><a className="button small" href={artifactUrl(agentId, artifact)} download>{t('artifacts.download')}</a><button type="button" className="icon-button" onClick={onClose} aria-label={t('artifacts.close')}>×</button></div></header>
      <div className="artifact-preview-body">
        {error ? <ErrorNotice>{error}</ErrorNotice> :
          artifact.type === 'markdown' ? <article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown></article> :
            artifact.type === 'image' ? <img src={previewUrl} alt={artifact.name} /> :
              <iframe src={previewUrl} title={artifact.name} sandbox={artifact.type === 'html' ? '' : undefined} />}
      </div>
    </section>
  </>;
}

function App() {
  const { locale, t } = useI18n();
  const [agents, setAgents] = useState([]);
  const [status, setStatus] = useState(null);
  const [providers, setProviders] = useState(blankProviders);
  const [providerForms, setProviderForms] = useState(blankProviders);
  const [providerFeedback, setProviderFeedback] = useState({});
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCloseConfirm, setSettingsCloseConfirm] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('kars-sidebar-hidden') === 'true');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadErrors, setLoadErrors] = useState([]);
  const [actionMessage, setActionMessage] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [sessionDeleteConfirm, setSessionDeleteConfirm] = useState(false);
  const [building, setBuilding] = useState('');
  const [buildConsole, setBuildConsole] = useState(null);
  const [buildLog, setBuildLog] = useState('');
  const [buildError, setBuildError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [chatting, setChatting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [chatStatus, setChatStatus] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [theme, setTheme] = useState(() => (typeof document !== 'undefined' ? document.documentElement.dataset.theme || 'light' : 'light'));
  const [pendingSelection, setPendingSelection] = useState(undefined);
  const [artifactPreview, setArtifactPreview] = useState(null);
  const chatController = useRef(null);
  const buildLock = useRef(false);
  const chatLock = useRef(false);
  const mutationLock = useRef(false);
  const providerDirty = useRef({});
  const hasProviderDraft = Object.values(providerDirty.current).some(Boolean);
  const bottom = useRef(null);
  const logs = useRef(null);
  const selected = agents.find((agent) => agent.id === selectedId);
  const chatSession = sessions.find((session) => session.id === sessionId);
  const activeAgent = agents.find((agent) => agent.id === chatSession?.currentAgentId);
  const completedMention = prompt.startsWith('@') && agents.some((agent) => {
    const mention = `@${agent.name}`;
    return prompt.toLocaleLowerCase().startsWith(mention.toLocaleLowerCase()) && /\s/.test(prompt[mention.length] || '');
  });
  const mentionSuggestions = prompt.startsWith('@') && !completedMention
    ? agents.filter((agent) => agent.name.toLocaleLowerCase().includes(prompt.slice(1).toLocaleLowerCase())).slice(0, 8)
    : [];
  const installed = status?.runtimes?.find((item) => item.id === form.runtime)?.installed;
  const karsManaged = status?.mode === 'kars-aks';
  const karsConnected = karsManaged && status?.karsConnected === true;
  const visibleRuntimes = RUNTIMES;
  const configLocked = !!busy || chatting;
  const needsCredential = !!selected && !providers[selected.runtime]?.hasCredential && !selected.hasCredential;
  const validationError = validateMcp(form.mcpServers);
  const validationErrorText = renderMessage(validationError, t);
  const messageFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), [locale]);
  const buildRuntime = buildConsole ? runtimeById(buildConsole.runtimeId) : null;
  const buildLabel = buildConsole ? t('build.console.title', { runtime: buildRuntime?.name || buildConsole.runtimeId, phase: t(`build.console.${buildConsole.phase}`) }) : '';
  const runtimeStatusLabel = (agentStatus) => karsManaged ? t('status.cloudDev') : statusText(agentStatus, t);
  const noticeText = renderMessage(notice, t);
  const historyErrorText = historyError ? t('errors.syncHistory', { message: renderMessage(historyError.message, t) }) : null;
  const chatErrorText = renderMessage(chatError, t);
  const buildErrorText = renderMessage(buildError, t);
  const chatStatusText = renderMessage(chatStatus, t);
  const loadErrorNodes = loadErrors.length ? loadErrors.map((entry, index) => <div key={`${entry.scope}-${index}`}>{t(`errors.load.${entry.scope}`, { message: renderMessage(entry.message, t) })}</div>) : null;

  async function refresh() {
    setRefreshing(true);
    const results = await Promise.allSettled([json('/api/status'), json('/api/agents'), json('/api/providers'), json('/api/sessions')]);
    const errors = [];
    if (results[0].status === 'fulfilled') setStatus(results[0].value);
    else {
      setStatus(null);
      errors.push(messageScope('environment', captureError(results[0].reason)));
    }
    if (results[1].status === 'fulfilled') setAgents(results[1].value);
    else errors.push(messageScope('agents', captureError(results[1].reason)));
    if (results[2].status === 'fulfilled') {
      setProviders(results[2].value);
      setProviderForms((current) => Object.fromEntries(Object.entries(results[2].value).map(([id, provider]) => [
        id,
        providerDirty.current[id] ? current[id] : { ...provider, credential: '' },
      ])));
    } else errors.push(messageScope('providers', captureError(results[2].reason)));
    if (results[3].status === 'fulfilled') {
      setSessions(results[3].value);
      setSessionId((current) => results[3].value.some((session) => session.id === current) ? current : results[3].value[0]?.id || null);
    } else errors.push(messageScope('sessions', captureError(results[3].reason)));
    setLoadErrors(errors);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !buildLock.current && !chatLock.current && !mutationLock.current) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    setMessages([]);
    setHistoryError(null);
    if (!sessionId) return undefined;
    const controller = new AbortController();
    setHistoryLoading(true);
    json(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setMessages(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setHistoryError(messageScope('syncHistory', captureError(error)));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, historyVersion]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, chatStatus, tab]);
  useEffect(() => { if (logs.current) logs.current.scrollTop = logs.current.scrollHeight; }, [buildLog]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('head.title');
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', t('head.description'));
  }, [locale, t]);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setDirty(true);
    setNotice(null);
    setActionMessage(null);
    setChatError(null);
  }

  function updateMcp(index, field, value) {
    update('mcpServers', form.mcpServers.map((server, itemIndex) => itemIndex === index ? { ...server, [field]: value } : server));
  }

  function editConfiguration(field = 'agent-name') {
    setSettingsOpen(true);
    setSettingsCloseConfirm(false);
    setTab('builder');
    requestAnimationFrame(() => {
      const input = document.getElementById(field);
      input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input?.focus({ preventScroll: true });
    });
  }

  function configureCredential() {
    setSettingsOpen(true);
    setTab('providers');
    requestAnimationFrame(() => document.getElementById(`provider-${selected?.runtime}-credential`)?.focus());
  }

  function selectAgent(id, force = false) {
    if (chatLock.current || mutationLock.current) return;
    if (id && id === selectedId) {
      setSettingsOpen(true);
      setSettingsCloseConfirm(false);
      setTab('builder');
      return;
    }
    if (dirty && !force) {
      setPendingSelection(id);
      return;
    }
    const agent = agents.find((item) => item.id === id);
    setSelectedId(agent?.id || null);
    setForm(agent ? agentForm(agent) : blankForm());
    setDirty(false);
    setSettingsOpen(true);
    setSettingsCloseConfirm(false);
    setTab('builder');
    setPrompt('');
    setHistoryLoading(false);
    setHistoryError(null);
    setChatError(null);
    setActionMessage(null);
    setNotice(null);
    setChatStatus(null);
    setDeleteConfirm(false);
    setPendingSelection(undefined);
  }

  function selectSession(id) {
    if (chatLock.current || mutationLock.current) return;
    setSessionId(id);
    setSettingsOpen(false);
    setTab('chat');
    setPrompt('');
    setChatError(null);
    setChatStatus(null);
    setSessionDeleteConfirm(false);
  }

  async function createSession() {
    if (mutationLock.current || chatLock.current) return;
    mutationLock.current = true;
    setBusy('new-session');
    try {
      const session = await json('/api/sessions', { method: 'POST', body: {} });
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setSettingsOpen(false);
      setTab('chat');
      setMessages([]);
      setPrompt('');
      setChatError(null);
      setChatStatus(null);
      setSessionDeleteConfirm(false);
    } catch (error) {
      setActionMessage(captureError(error));
    } finally {
      mutationLock.current = false;
      setBusy('');
    }
  }

  function openSettings(panel = 'builder') {
    setSettingsOpen(true);
    setSettingsCloseConfirm(false);
    setTab(panel);
  }

  function closeSettings(force = false) {
    if ((dirty || hasProviderDraft) && !force) {
      setSettingsCloseConfirm(true);
      return;
    }
    setSettingsOpen(false);
    setSettingsCloseConfirm(false);
    setTab('chat');
  }

  function discardSettings() {
    providerDirty.current = {};
    setProviderForms(Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, { ...provider, credential: '' }])));
    setProviderFeedback({});
    setDirty(false);
    closeSettings(true);
  }

  async function deleteSession() {
    if (!chatSession || mutationLock.current || chatLock.current) return;
    mutationLock.current = true;
    setBusy('delete-session');
    setActionMessage(null);
    setChatError(null);
    try {
      await json(`/api/sessions/${encodeURIComponent(chatSession.id)}`, { method: 'DELETE', body: {} });
      const remaining = sessions.filter((session) => session.id !== chatSession.id);
      setSessions(remaining);
      setSessionId(remaining[0]?.id || null);
      setMessages([]);
      setSessionDeleteConfirm(false);
      setNotice(keyMessage('notice.sessionDeleted'));
    } catch (error) {
      setChatError(captureError(error));
    } finally {
      mutationLock.current = false;
      setBusy('');
    }
  }

  function chooseRuntime(id) {
    if (configLocked || selected || form.runtime === id) return;
    const preset = runtimeById(id);
    setForm((current) => ({ ...current, runtime: id, model: preset.model, baseUrl: preset.baseUrl, credential: '' }));
    setDirty(true);
    setNotice(null);
    setActionMessage(null);
  }

  function updateProvider(runtime, name, value) {
    providerDirty.current[runtime] = true;
    setProviderForms((current) => ({ ...current, [runtime]: { ...current[runtime], [name]: value } }));
    setProviderFeedback((current) => ({ ...current, [runtime]: null }));
    setNotice(null);
    setActionMessage(null);
  }

  async function saveProvider(event, runtime) {
    event.preventDefault();
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(`provider-${runtime}`);
    setProviderFeedback((current) => ({ ...current, [runtime]: { status: 'saving' } }));
    setNotice(null);
    setActionMessage(null);
    try {
      const provider = await json(`/api/providers/${runtime}`, {
        method: 'PUT',
        body: {
          model: providerForms[runtime].model.trim(),
          baseUrl: providerForms[runtime].baseUrl.trim(),
          credential: providerForms[runtime].credential,
        },
      });
      setProviders((current) => ({ ...current, [runtime]: provider }));
      providerDirty.current[runtime] = false;
      setProviderForms((current) => ({ ...current, [runtime]: { ...provider, credential: '' } }));
      setProviderFeedback((current) => ({ ...current, [runtime]: { status: 'saved' } }));
      setNotice(keyMessage('notice.providerSaved', { provider: runtimeById(runtime)?.name || runtime }));
      const refreshedAgents = await json('/api/agents');
      setAgents(refreshedAgents);
      if (selectedId) {
        const selectedAgent = refreshedAgents.find((agent) => agent.id === selectedId);
        if (selectedAgent) setForm(agentForm(selectedAgent));
      }
    } catch (error) {
      const message = captureError(error);
      setProviderFeedback((current) => ({ ...current, [runtime]: { status: 'error', message } }));
      setActionMessage(message);
    } finally {
      mutationLock.current = false;
      setBusy('');
    }
  }

  function replaceAgent(agent) {
    setAgents((current) => current.some((item) => item.id === agent.id) ? current.map((item) => item.id === agent.id ? agent : item) : [...current, agent]);
  }

  async function save(event) {
    event.preventDefault();
    if (configLocked || mutationLock.current) return;
    if (validationError) {
      setActionMessage(validationError);
      return;
    }
    if (!form.name.trim()) {
      setActionMessage(keyMessage('errors.validation.nameRequired'));
      return;
    }
    if (selected?.hasCredential && selected.runtime !== form.runtime && !form.credential.trim()) {
      setActionMessage(keyMessage('errors.validation.runtimeCredential'));
      return;
    }
    if (form.skills.some((skill) => !skill.name.trim() || (!skill.uploaded && !skill.file))) {
      setActionMessage(keyMessage('errors.validation.skillRequired'));
      return;
    }
    if (form.skills.some((skill) => skill.file && (skill.file.size > 5 * 1024 * 1024 || !skill.file.name.toLowerCase().endsWith('.zip')))) {
      setActionMessage(keyMessage('errors.validation.skillZip'));
      return;
    }
    if (new Set(form.skills.map((skill) => skill.name.trim())).size !== form.skills.length) {
      setActionMessage(keyMessage('errors.validation.skillDuplicate'));
      return;
    }
    mutationLock.current = true;
    setBusy('save');
    setNotice(null);
    setActionMessage(null);
    setChatError(null);
    setLoadErrors([]);
    try {
      const pendingSkills = form.skills.filter((skill) => !skill.uploaded);
      const payload = {
        name: form.name.trim(),
        runtime: form.runtime,
        model: providers[form.runtime]?.model || form.model.trim(),
        baseUrl: providers[form.runtime]?.baseUrl || form.baseUrl.trim(),
        credential: '',
        instructions: form.instructions,
        tools: form.tools,
        mcpServers: serializeMcpServers(form),
        skills: form.skills.filter((skill) => skill.uploaded).map(({ uploaded, file, ...skill }) => skill),
      };
      let agent = await json(selectedId ? `/api/agents/${encodeURIComponent(selectedId)}` : '/api/agents', { method: selectedId ? 'PUT' : 'POST', body: payload });
      setSelectedId(agent.id);
      for (const skill of pendingSkills) {
        const response = await api(`/api/agents/${encodeURIComponent(agent.id)}/skills/${encodeURIComponent(skill.name.trim())}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/zip',
            'X-Skill-Filename': encodeURIComponent(skill.file.name),
          },
          body: skill.file,
          rawBody: true,
        });
        agent = await response.json();
      }
      replaceAgent(agent);
      setForm(agentForm(agent));
      setDirty(false);
      setNotice(karsManaged
        ? keyMessage(agent.hasCredential ? 'notice.saved.kars' : 'notice.saved.karsWithoutCredential')
        : keyMessage(agent.hasCredential ? 'notice.saved.withCredential' : 'notice.saved.withoutCredential'));
    } catch (error) {
      setActionMessage(captureError(error));
    } finally {
      mutationLock.current = false;
      setBusy('');
    }
  }

  async function lifecycle(action) {
    if (!selected || mutationLock.current || chatLock.current) return;
    mutationLock.current = true;
    setBusy(action);
    setNotice(null);
    setActionMessage(null);
    setChatError(null);
    try {
      const result = await json(`/api/agents/${encodeURIComponent(selected.id)}${action === 'delete' ? '' : `/${action}`}`, { method: action === 'delete' ? 'DELETE' : 'POST', body: {} });
      if (action === 'delete') {
        setAgents((current) => current.filter((agent) => agent.id !== selected.id));
        setSelectedId(null);
        setForm(blankForm());
        setDirty(false);
        setTab('builder');
        setNotice(keyMessage('notice.deleted'));
      } else {
        replaceAgent(result);
        setNotice(action === 'start'
          ? (result.hasCredential ? keyMessage('notice.started.withCredential') : keyMessage('notice.started.withoutCredential'))
          : keyMessage('notice.stopped'));
      }

      setDeleteConfirm(false);
      await refresh();
    } catch (error) {
      setActionMessage(captureError(error));
    } finally {
      mutationLock.current = false;
      setBusy('');
    }
  }

  async function buildImage(id) {
    if (buildLock.current || !status?.docker) return;
    buildLock.current = true;
    setBuilding(id);
    setNotice(null);
    setActionMessage(null);
    setBuildConsole({ runtimeId: id, phase: 'building' });
    setBuildLog('');
    setBuildError(null);
    try {
      await stream(`/api/images/${id}/build`, {}, (event) => {
        if (event.type === 'log') setBuildLog((current) => (current + event.text).slice(-100000));
        if (event.type === 'done') setBuildConsole((current) => (current ? { ...current, phase: 'done' } : { runtimeId: id, phase: 'done' }));
      });
    } catch (error) {
      setBuildError(captureError(error));
      setBuildConsole((current) => (current ? { ...current, phase: 'failed' } : { runtimeId: id, phase: 'failed' }));
    } finally {
      await refresh();
      buildLock.current = false;
      setBuilding('');
    }
  }

  async function send(event) {
    event.preventDefault();
    if (!chatSession || !prompt.trim() || chatLock.current || cancelling || busy || historyLoading || historyError) return;
    const text = prompt.trim();
    const priorMessageCount = messages.length;
    const orderedAgents = [...agents].sort((a, b) => b.name.length - a.name.length);
    const targetAgent = text.startsWith('@')
      ? orderedAgents.find((agent) => {
        const mention = `@${agent.name}`;
        return text.toLocaleLowerCase().startsWith(mention.toLocaleLowerCase()) && (text.length === mention.length || /\s/.test(text[mention.length]));
      })
      : activeAgent;
    const controller = new AbortController();
    chatController.current = controller;
    chatLock.current = true;
    setChatting(true);
    setNotice(null);
    setActionMessage(null);
    setChatError(null);
    setChatStatus(keyMessage('chat.status.connecting'));
    setPrompt('');
    setMessages((current) => [
      ...current,
      { role: 'user', content: text, agentId: targetAgent?.id, agentName: targetAgent?.name, createdAt: new Date().toISOString() },
      { role: 'assistant', content: '', agentId: targetAgent?.id, agentName: targetAgent?.name, streaming: true },
    ]);
    try {
      await stream(`/api/sessions/${encodeURIComponent(chatSession.id)}/chat`, { prompt: text }, (event) => {
        if (event.type === 'text') {
          setChatStatus(keyMessage('chat.status.generating'));
          setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, content: message.content + event.text } : message));
        }
        if (event.type === 'status') setChatStatus(rawMessage(event.text, event.translations));
        if (event.type === 'artifacts') {
          setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, artifacts: event.artifacts } : message));
        }
        if (event.type === 'done') setChatStatus(keyMessage('chat.status.completed'));
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) setChatStatus(keyMessage('chat.status.stopped'));
      else if (isRecoverableChatError(error)) {
        setChatError(null);
        setChatStatus(keyMessage('chat.status.recovering'));
        const recovered = await recoverChatHistory(
          () => json(`/api/sessions/${encodeURIComponent(chatSession.id)}/messages`),
          { priorMessageCount, signal: controller.signal },
        );
        const completion = recovered?.slice(priorMessageCount + 1).at(-1);
        if (completion?.role === 'assistant') {
          setMessages(recovered);
          setChatStatus(keyMessage('chat.status.completed'));
        } else {
          const recoveryError = completion?.content
            ? new Error(completion.content)
            : new Error(t('api.errors.recoveryTimeout'));
          setChatError(captureError(recoveryError));
          setChatStatus(keyMessage('chat.status.notFinished'));
        }
      }
      else {
        setChatError(captureError(error));
        setChatStatus(keyMessage('chat.status.notFinished'));
      }
    } finally {
      setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
      setHistoryLoading(true);
      try {
        const [history, updatedSessions] = await Promise.all([
          json(`/api/sessions/${encodeURIComponent(chatSession.id)}/messages`),
          json('/api/sessions'),
        ]);
        setMessages(history);
        setSessions(updatedSessions);
        setHistoryError(null);
      } catch (error) {
        setHistoryError(messageScope('syncHistory', captureError(error)));
      }
      setHistoryLoading(false);
      chatController.current = null;
      chatLock.current = false;
      setChatting(false);
    }
  }

  async function cancelChat() {
    if (!sessionId || cancelling) return;
    const controller = chatController.current;
    setCancelling(true);
    try {
      await json(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: {} });
      controller?.abort();
      setChatStatus(keyMessage('chat.status.cancelRequested'));
    } catch (error) {
      setChatError({ kind: 'cancel', message: captureError(error) });
    } finally {
      setCancelling(false);
    }
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    setTheme(next);
  }

  function toggleSidebar() {
    setSidebarHidden((hidden) => {
      localStorage.setItem('kars-sidebar-hidden', String(!hidden));
      return !hidden;
    });
  }

  const visibleBuildConsole = buildConsole && buildLabel;

  return (
    <div className="app-shell portal-ui">
      <a className="skip-link" href="#main">{t('skip.main')}</a>
      <aside id="workspace-sidebar" className={`sidebar ${sidebarHidden ? 'sidebar-hidden' : ''}`} aria-label={t('sidebar.workspace')}>
        <div className="workspace-label"><span className="workspace-avatar">{karsManaged ? 'C' : 'L'}</span><div>{t(karsManaged ? 'sidebar.cloudWorkspace' : 'sidebar.workspace')}<small>{t(karsManaged ? 'sidebar.cloudScope' : 'sidebar.personal')}</small></div><span className="dot success-dot" /></div>
        <div className="sidebar-section-title"><span>{t('sidebar.section.workspace')}</span><span>01</span></div>
        <div className="nav-current"><Icon name="sliders" />{t('page.title')}<Icon name="chevron" size={14} /></div>
        <div className="sidebar-section-title agent-list-title"><span>{t('sidebar.section.agents')}</span><span>{agents.length}</span></div>
        <button className="new-agent-button" onClick={() => selectAgent(null)} disabled={!!busy || chatting}><Icon name="plus" size={17} />{t('sidebar.createAgent')}</button>
        <nav className="agent-list" aria-label={t('sidebar.section.agents')}>
          {loading ? <p className="sidebar-empty">{t('sidebar.loading')}</p> : agents.length === 0 ? <div className="sidebar-empty"><span>{renderLines(t('sidebar.empty.title'))}</span><small>{t('sidebar.empty.subtitle')}</small></div> : agents.map((agent) => (
            <button key={agent.id} className={`agent-item ${selectedId === agent.id ? 'selected' : ''}`} onClick={() => selectAgent(agent.id)} disabled={!!busy || chatting} aria-current={selectedId === agent.id ? 'page' : undefined}>
              <span className="agent-mark">{runtimeById(agent.runtime)?.mark || 'A'}</span>
              <span className="agent-item-copy"><strong>{agent.name}</strong><small>{runtimeById(agent.runtime)?.name} · {runtimeStatusLabel(agent.status)}</small></span>
              <span className={`dot ${agent.status === 'running' ? 'success-dot' : ''}`} />
            </button>
          ))}
        </nav>
        <div className="sidebar-section-title agent-list-title"><span>{t('sidebar.section.sessions')}</span><span>{sessions.length}</span></div>
        <button className="new-agent-button" onClick={createSession} disabled={!!busy || chatting}><Icon name="plus" size={17} />{t('sidebar.newSession')}</button>
        <nav className="agent-list" aria-label={t('sidebar.section.sessions')}>
          {sessions.map((session) => (
            <button key={session.id} className={`agent-item ${sessionId === session.id && tab === 'chat' ? 'selected' : ''}`} onClick={() => selectSession(session.id)} disabled={!!busy || chatting}>
              <span className="agent-mark"><Icon name="chat" size={15} /></span>
              <span className="agent-item-copy"><strong>{session.title}</strong><small>{session.currentAgentId ? agents.find((agent) => agent.id === session.currentAgentId)?.name || t('chat.agentDeleted') : t('chat.noAgent')}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card"><Icon name="shield" size={20} /><strong>{t(karsManaged ? 'sidebar.cloudCard.title' : 'sidebar.localCard.title')}</strong><p>{renderLines(t(karsManaged ? 'sidebar.cloudCard.body' : 'sidebar.localCard.body'))}</p></div>
          <div className="sidebar-footer"><span><span className="dot" />{t(karsManaged ? 'sidebar.footer.cloudMode' : 'sidebar.footer.mode')}</span></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-leading">
            <button className="icon-button sidebar-toggle" type="button" onClick={toggleSidebar} aria-controls="workspace-sidebar" aria-expanded={!sidebarHidden} aria-label={t(sidebarHidden ? 'sidebar.show' : 'sidebar.hide')} title={t(sidebarHidden ? 'sidebar.show' : 'sidebar.hide')}><Icon name="panel" size={19} /></button>
            <a className="portal-brand" href="/" aria-label={t('brand.home')}><Icon name="box" size={22} /><strong>KARS</strong><span>{t('page.title')}</span></a>
          </div>
          <div className="topbar-right">
            <button className="button small settings-button" type="button" onClick={() => openSettings('builder')} disabled={!!busy || chatting}><Icon name="sliders" size={15} />{t('settings.button')}</button>
            <div className="language-switch"><LanguageSelect /></div>
            <button className="icon-button portal-theme-toggle" onClick={toggleTheme} aria-label={t('theme.toggleAria', { mode: localizedThemeMode(theme, t) })} title={t('theme.toggleTitle')}><Icon name="sun" /></button>
            <span className="local-pill"><span className="dot" />{t(karsManaged ? 'topbar.cloudDev' : 'topbar.localDev')}</span>
            <span className="profile" aria-label={t('topbar.profile')}>BYO</span>
          </div>
        </header>
        <main id="main">
          <div className="breadcrumb">{t('topbar.workspace')} <span>/</span> <strong>{t('page.title')}</strong></div>
          <div className="page-heading"><div><div className="eyebrow">{t('page.eyebrow')}</div><h1>{t('page.title')}<span className="heading-dot">.</span></h1><p>{t('page.description')}</p></div><span className="edition">{t(karsManaged ? 'page.cloudEdition' : 'page.edition')} <Icon name="box" size={16} /></span></div>
          <div className="environment-bar">
            <div className="environment-title">
              <Icon name="terminal" />
              <strong>{t('environment.title')}</strong>
              <span className={`badge ${(karsManaged ? karsConnected : status?.docker) ? 'success' : status ? 'warning' : ''}`}><span className="dot" />{status ? (karsManaged ? (karsConnected ? t('environment.cloudReady') : t('environment.cloudUnavailable')) : status.docker ? t('environment.ready') : t('environment.unavailable')) : loading ? t('environment.checking') : t('environment.unknown')}</span>
              <span className="environment-description">{karsManaged ? (karsConnected ? t('environment.description.cliReady') : t('environment.description.cloudUnavailable')) : status?.docker ? t('environment.description.ready') : t('environment.description.unavailable')}</span>
            </div>
            <button className="text-button" onClick={refresh} disabled={refreshing || !!busy || chatting || !!building}><Icon name="refresh" size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? t('environment.checking') : t('environment.recheck')}</button>
          </div>
          <ErrorNotice>{loadErrorNodes}</ErrorNotice>
          <ErrorNotice>{status?.dockerError}</ErrorNotice>
          {pendingSelection !== undefined && <div className="notice warning" role="alert"><div><strong>{t('notice.pendingSelection.title')}</strong>{t('notice.pendingSelection.body')}</div><div className="inline-actions"><button className="button small" onClick={() => setPendingSelection(undefined)}>{t('notice.pendingSelection.continue')}</button><button className="button small danger-button" onClick={() => selectAgent(pendingSelection, true)}>{t('notice.pendingSelection.discard')}</button></div></div>}
          {settingsOpen && <button className="settings-backdrop" type="button" aria-label={t('settings.close')} onClick={() => closeSettings()} />}
          <section className={`studio-panel ${settingsOpen ? 'settings-modal' : ''}`} aria-labelledby="studio-title" aria-modal={settingsOpen || undefined} role={settingsOpen ? 'dialog' : undefined}>
            <div className="studio-heading">
              <div className="studio-heading-copy">
                <span className="section-number">{settingsOpen ? t('settings.title') : t('chat.workspaceTitle')}</span>
                <h2 id="studio-title">{settingsOpen ? selected ? selected.name : t('settings.title') : t('chat.workspaceTitle')}</h2>
                {settingsOpen && selected && <StatusBadge status={selected.status} cloud={karsManaged} />}
                {(dirty || hasProviderDraft) && <span className="unsaved">{t('common.unsaved')}</span>}
              </div>
              <div className="studio-heading-actions">{settingsOpen && selected && <>
                {tab === 'builder' && <button className="button small primary" type="submit" form="agent-config-form" disabled={configLocked || !dirty || !!validationError || !form.name.trim()} title={t('studio.saveChangesTitle')}>{busy === 'save' ? t('studio.saving') : t('studio.saveChanges')}</button>}
                {!karsManaged && <button className="button small" disabled={!!busy || chatting || !status?.docker || (selected.status !== 'running' && (!installed || dirty || !!building))} onClick={() => lifecycle(selected.status === 'running' ? 'stop' : 'start')}><Icon name={selected.status === 'running' ? 'stop' : 'play'} size={14} />{busy === 'start' ? t('studio.starting') : busy === 'stop' ? t('studio.stopping') : selected.status === 'running' ? t('studio.stopContainer') : t('studio.startContainer')}</button>}
                <button className="icon-button" aria-label={t('studio.deleteAria')} title={t('studio.deleteTitle')} disabled={!!busy || chatting} onClick={() => setDeleteConfirm(!deleteConfirm)}><Icon name="trash" size={17} /></button>
              </>}{settingsOpen && <button className="icon-button settings-close" type="button" aria-label={t('settings.close')} title={t('settings.close')} onClick={() => closeSettings()}><span aria-hidden="true">×</span></button>}</div>
            </div>
            {settingsOpen && <div className="tabs" aria-label={t('settings.title')}><button className={tab === 'builder' ? 'tab active' : 'tab'} aria-pressed={tab === 'builder'} onClick={() => setTab('builder')}><Icon name="sliders" size={17} />{t('tabs.builder')}</button><button className={tab === 'providers' ? 'tab active' : 'tab'} aria-pressed={tab === 'providers'} onClick={() => setTab('providers')}><Icon name="shield" size={17} />{t('tabs.providers')}</button></div>}
            <div className="panel-messages">
              <ErrorNotice>{actionMessage && renderMessage(actionMessage, t)}</ErrorNotice>
              {tab !== 'chat' && needsCredential && <div className="notice warning" role="alert"><Icon name="shield" size={18} /><div><strong>{t('warning.needsCredential.title', { credential: t(credentialKey(selected.runtime)) })}</strong><br />{t(karsManaged ? 'warning.needsCredential.cloudBody' : 'warning.needsCredential.body', { cli: runtimeById(selected.runtime)?.name || selected.runtime })}</div><button className="button small" onClick={configureCredential} disabled={configLocked}>{t('warning.needsCredential.button')}</button></div>}
              {noticeText && <div className="notice success" role="status"><Icon name="check" size={17} /><div>{noticeText}</div></div>}
              {deleteConfirm && <div className="notice warning" role="alert"><div><strong>{t('studio.deleteConfirmTitle', { name: selected?.name || '' })}</strong>{t('studio.deleteConfirmBody')}</div><div className="inline-actions"><button className="button small" onClick={() => setDeleteConfirm(false)} disabled={!!busy}>{t('studio.deleteKeep')}</button><button className="button small danger-button" onClick={() => lifecycle('delete')} disabled={!!busy}>{busy === 'delete' ? t('studio.deleting') : t('studio.deleteConfirmAction')}</button></div></div>}
              {settingsCloseConfirm && <div className="notice warning" role="alert"><div><strong>{t('settings.unsavedTitle')}</strong>{t('settings.unsavedBody')}</div><div className="inline-actions"><button className="button small" type="button" onClick={() => setSettingsCloseConfirm(false)}>{t('settings.keepEditing')}</button><button className="button small danger-button" type="button" onClick={discardSettings}>{t('settings.discard')}</button></div></div>}
            </div>
            {tab === 'providers' ? <div className="builder-layout">
              <div className="agent-form">
                {RUNTIMES.map((runtime, index) => {
                  const provider = providerForms[runtime.id];
                  return <form key={runtime.id} onSubmit={(event) => saveProvider(event, runtime.id)}><fieldset className="form-section" disabled={!!busy}>
                    <legend><span className="step">0{index + 1}</span>{runtime.name}<span className="legend-note">{providerDirty.current[runtime.id] ? t('common.unsaved') : providers[runtime.id]?.hasCredential ? t('providers.configured') : t('providers.notConfigured')}</span></legend>
                    <div className="field">
                      <label htmlFor={`provider-${runtime.id}-model`}>{t('fields.model.label')} <span className="required">*</span></label>
                      <input className="mono-input" id={`provider-${runtime.id}-model`} value={provider.model} onChange={(event) => updateProvider(runtime.id, 'model', event.target.value)} required spellCheck="false" />
                      <span className="field-hint">{t(`fields.model.${runtime.id}.hint`)}</span>
                    </div>
                    {runtime.id !== 'copilot' && <div className="field">
                      <label htmlFor={`provider-${runtime.id}-base-url`}>{t(baseUrlKey(runtime.id))} <span className="required">*</span></label>
                      <input className="mono-input" id={`provider-${runtime.id}-base-url`} type="url" value={provider.baseUrl} onChange={(event) => updateProvider(runtime.id, 'baseUrl', event.target.value)} required spellCheck="false" />
                      <span className="field-hint">{t(`fields.baseUrl.${runtime.id}Hint`)}</span>
                    </div>}
                    <div className="field">
                      <label htmlFor={`provider-${runtime.id}-credential`}>{t(credentialKey(runtime.id))}<span className="field-tag"><Icon name="shield" size={11} />{t('fields.credential.badge')}</span></label>
                      <input id={`provider-${runtime.id}-credential`} type="password" value={provider.credential} onChange={(event) => updateProvider(runtime.id, 'credential', event.target.value)} placeholder={providers[runtime.id]?.hasCredential ? t('fields.credential.placeholder.existing') : t('fields.credential.placeholder.new')} autoComplete="new-password" spellCheck="false" />
                      <span className="field-hint">{t(`fields.credential.${runtime.id}Hint`)}</span>
                    </div>
                    <div className="provider-note"><Icon name="shield" size={16} /><p>{t(`provider.${runtime.id}`)}<span>{t('providers.sharedHint')}</span></p></div>
                    {providerFeedback[runtime.id]?.status === 'error' && <ErrorNotice>{renderMessage(providerFeedback[runtime.id].message, t)}</ErrorNotice>}
                    {providerFeedback[runtime.id]?.status === 'saved' && <div className="notice success provider-save-feedback" role="status"><Icon name="check" size={16} /><div>{t('providers.saved', { provider: runtime.name })}</div></div>}
                    <button className="button primary" type="submit" disabled={!!busy || !provider.model.trim() || (runtime.id !== 'copilot' && !provider.baseUrl.trim()) || (!providers[runtime.id]?.hasCredential && !provider.credential.trim())}>{busy === `provider-${runtime.id}` ? t('studio.saving') : t('providers.save')}</button>
                  </fieldset></form>;
                })}
              </div>
            </div> : tab === 'builder' ? <div className="builder-layout">
              <form id="agent-config-form" className="agent-form" onSubmit={save}>
                <fieldset className="form-section runtime-section" disabled={configLocked || !!selected}><legend><span className="step">01</span>{t('builder.runtime.title')}<span className="legend-note">{selected ? t('builder.runtime.legend.selected') : t('builder.runtime.legend.new')}</span></legend><div className="runtime-grid">{visibleRuntimes.map((item) => {
                  const image = status?.runtimes?.find((entry) => entry.id === item.id);
                  return <button type="button" className={`runtime-card ${form.runtime === item.id ? 'chosen' : ''}`} key={item.id} onClick={() => chooseRuntime(item.id)} aria-pressed={form.runtime === item.id}><span className="runtime-top"><span className={`runtime-symbol ${item.id}`}>{item.mark}</span><span className="radio-indicator">{form.runtime === item.id && <span />}</span></span><strong>{item.name}</strong><span className="runtime-label">{t(item.labelKey)}</span><p>{t(item.descriptionKey)}</p><span className={`image-state ${(karsManaged ? karsConnected : image?.installed) ? 'available' : ''}`}><span className="dot" />{karsManaged ? (karsConnected ? t('builder.runtime.card.cloudReady') : t('builder.runtime.card.cloudUnavailable')) : image?.installed ? t('builder.runtime.card.ready') : image ? t('builder.runtime.card.needBuild') : t('builder.runtime.card.unknown')}</span></button>;
                })}</div></fieldset>
                {selected?.status === 'running' && <div className="notice neutral"><Icon name="shield" size={18} /><span>{t(karsManaged ? 'builder.cloudNotice' : 'builder.runningNotice')}</span></div>}
                <fieldset className="form-section" disabled={configLocked}>
                  <legend><span className="step">02</span>{t('builder.base.title')}<span className="legend-note">{t('builder.base.legend')}</span></legend>
                  <div className="field">
                    <label htmlFor="agent-name">{t('fields.agentName.label')} <span className="required">*</span></label>
                    <input id="agent-name" value={form.name} onChange={(event) => update('name', event.target.value)} placeholder={t('fields.agentName.placeholder')} required maxLength={100} autoComplete="off" />
                    <span className="field-hint">{t('fields.agentName.hint')}</span>
                  </div>
                  <div className="provider-note"><Icon name="shield" size={16} /><p>{t('providers.agentUses', { provider: runtimeById(form.runtime)?.name || form.runtime, model: providers[form.runtime]?.model || form.model })}<span>{providers[form.runtime]?.hasCredential ? t('providers.configured') : t('providers.configureFirst')}</span></p></div>
                </fieldset>
                <fieldset className="form-section" disabled={configLocked}>
                  <legend><span className="step">03</span>{t('builder.instructions.title')}<span className="legend-note">{t('builder.instructions.legend')}</span></legend>
                  <div className="field">
                    <label htmlFor="instructions">{t('fields.instructions.label')} <span className="optional">{t('common.optional')}</span></label>
                    <textarea id="instructions" rows={5} value={form.instructions} onChange={(event) => update('instructions', event.target.value)} placeholder={t('fields.instructions.placeholder')} />
                    <span className="field-hint">{t('fields.instructions.hint')}</span>
                  </div>
                  <label className={`capability-toggle ${form.tools ? 'enabled' : ''}`}>
                    <span className="capability-icon"><Icon name="terminal" size={20} /></span>
                    <span className="capability-copy">
                      <strong>{t('fields.tools.label')}</strong>
                      <small>{t('fields.tools.hint')}</small>
                    </span>
                    <input type="checkbox" checked={form.tools} onChange={(event) => update('tools', event.target.checked)} />
                  </label>
                  <div className="skill-header mcp-header">
                    <div><h3>{t('fields.mcp.label')} <span className="optional">{t('common.optional')}</span></h3><p id="mcp-hint">{t('fields.mcp.hint')}</p></div>
                    <div className="mcp-header-actions"><span className="badge">{form.tools ? t('fields.mcp.badge.enabled') : t('fields.mcp.badge.savedOnly')}</span><button className="button small" type="button" onClick={() => update('mcpServers', [...form.mcpServers, newMcpServer(form.mcpServers)])}><Icon name="plus" size={14} />{t('fields.mcp.add')}</button></div>
                  </div>
                  {validationErrorText && <span className="field-error mcp-error" id="mcp-error" role="alert">{validationErrorText}</span>}
                  {form.mcpServers.length === 0 ? <div className="skills-empty mcp-empty"><Icon name="terminal" size={21} /><span>{t('fields.mcp.emptyTitle')} <small>{t('fields.mcp.emptyHint')}</small></span></div> : <div className="skill-list mcp-list" aria-describedby="mcp-hint">
                    {form.mcpServers.map((server, index) => <div className="skill-card mcp-card" key={index}>
                      <div className="skill-card-heading"><strong>{t('fields.mcp.cardPrefix', { index: String(index + 1).padStart(2, '0') })}</strong><button type="button" className="icon-button" aria-label={t('fields.mcp.removeAria', { index: index + 1 })} onClick={() => update('mcpServers', form.mcpServers.filter((_, itemIndex) => index !== itemIndex))}><Icon name="trash" size={15} /></button></div>
                      <div className="field-row">
                        <div className="field"><label htmlFor={`mcp-endpoint-${index}`}>{t('fields.mcp.endpoint')} <span className="required">*</span></label><input id={`mcp-endpoint-${index}`} type="url" value={server.endpoint} onChange={(event) => updateMcp(index, 'endpoint', event.target.value)} placeholder="https://mcp.example.com/mcp" aria-invalid={!!validationError} /></div>
                        <div className="field"><label htmlFor={`mcp-key-${index}`}>{t('fields.mcp.key')} <span className="optional">{t('common.optional')}</span></label><input id={`mcp-key-${index}`} type="password" value={server.key} onChange={(event) => updateMcp(index, 'key', event.target.value)} autoComplete="off" placeholder={t(server.hasKey ? 'fields.mcp.keyConfigured' : 'fields.mcp.keyPlaceholder')} aria-invalid={!!validationError} /></div>
                      </div>
                    </div>)}
                  </div>}
                  <div className="skill-header">
                    <div><h3>{t('fields.skills.title')} <span className="optional">{t('common.optional')}</span></h3><p>{t('fields.skills.hint')}</p></div>
                    <button className="button small" type="button" onClick={() => update('skills', [...form.skills, { name: '', fileName: '', file: null, uploaded: false }])}><Icon name="plus" size={14} />{t('fields.skills.add')}</button>
                  </div>
                  {form.skills.length === 0 ? <div className="skills-empty"><Icon name="box" size={21} /><span>{t('fields.skills.emptyTitle')} <small>{t('fields.skills.emptyHint')}</small></span></div> : <div className="skill-list">
                    {form.skills.map((skill, index) => <div className="skill-card" key={index}>
                      <div className="skill-card-heading"><strong>{t('fields.skills.cardPrefix', { index: String(index + 1).padStart(2, '0') })}</strong><button type="button" className="icon-button" aria-label={t('fields.skills.removeAria', { index: index + 1 })} onClick={() => update('skills', form.skills.filter((_, itemIndex) => index !== itemIndex))}><Icon name="trash" size={15} /></button></div>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor={`skill-name-${index}`}>{t('fields.skills.name.label')} <span className="required">*</span></label>
                          <input id={`skill-name-${index}`} value={skill.name} required readOnly={skill.uploaded} placeholder={t('fields.skills.name.placeholder')} onChange={(event) => update('skills', form.skills.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />
                        </div>
                        <div className="field">
                          <label htmlFor={`skill-file-${index}`}>{t('fields.skills.file.label')} <span className="required">*</span></label>
                          {skill.uploaded ? <div className="skill-file-saved"><Icon name="check" size={15} /><span>{skill.fileName || `${skill.name}.zip`}</span><span className="badge success">{t('fields.skills.file.saved')}</span></div> : <input id={`skill-file-${index}`} className="skill-file-input" type="file" accept=".zip,application/zip" required onChange={(event) => update('skills', form.skills.map((item, itemIndex) => itemIndex === index ? { ...item, file: event.target.files?.[0] || null, fileName: event.target.files?.[0]?.name || '' } : item))} />}
                        </div>
                      </div>
                    </div>)}
                  </div>}
                </fieldset>
                <div className="form-footer"><span><Icon name="shield" size={14} />{selected ? t('form.footer.selected') : t('form.footer.new')}</span><button className="button primary" type="submit" disabled={configLocked || !!validationError || !form.name.trim() || (!!selected && !dirty)}>{busy === 'save' ? t('studio.saving') : selected ? t('form.submit.save') : t('form.submit.create')}<Icon name="arrow" size={16} /></button></div>
              </form>
              {karsManaged ? <aside className="builder-guide" aria-label={t('guide.cloud.title')}>
                <div className="guide-card"><div className="guide-eyebrow">{t('guide.cloud.eyebrow')}</div><h3>{t('guide.cloud.title')}</h3><p>{renderLines(t('guide.cloud.description'))}</p><ol className="checklist"><li className={karsConnected ? 'complete' : ''}><span>{karsConnected ? <Icon name="check" size={13} /> : '1'}</span><div><strong>{t('guide.cloud.connection')}</strong><small>{t(karsConnected ? 'guide.cloud.connectionReady' : 'guide.cloud.connectionUnavailable')}</small></div></li><li className={selected ? 'complete' : ''}><span>{selected ? <Icon name="check" size={13} /> : '2'}</span><div><strong>{t('guide.cloud.save')}</strong><small>{t('guide.cloud.saveHint')}</small></div></li><li className={selected?.status === 'running' ? 'complete' : ''}><span>{selected?.status === 'running' ? <Icon name="check" size={13} /> : '3'}</span><div><strong>{t('guide.cloud.chat')}</strong><small>{t('guide.cloud.chatHint')}</small></div></li></ol></div>
                <div className="development-note"><div className="note-icon"><Icon name="box" size={20} /></div><h3>{t('guide.cloud.scopeTitle')}</h3><p>{t('guide.cloud.scopeBody')}</p><span>{t('guide.cloud.footer')} <Icon name="arrow" size={14} /></span></div>
              </aside> : <aside className="builder-guide" aria-label={t('guide.title')}>
                <div className="guide-card"><div className="guide-eyebrow">{t('guide.eyebrow')}</div><h3>{t('guide.title')}</h3><p>{renderLines(t('guide.description'))}</p><ol className="checklist"><li className={installed ? 'complete' : ''}><span>{installed ? <Icon name="check" size={13} /> : '1'}</span><div><strong>{t('guide.step1.title')}</strong><small>{t('guide.step1.subtitle')}</small></div></li><li className={selected ? 'complete' : ''}><span>{selected ? <Icon name="check" size={13} /> : '2'}</span><div><strong>{t('guide.step2.title')}</strong><small>{t('guide.step2.subtitle')}</small></div></li><li className={selected?.status === 'running' ? 'complete' : ''}><span>{selected?.status === 'running' ? <Icon name="check" size={13} /> : '3'}</span><div><strong>{t('guide.step3.title')}</strong><small>{t('guide.step3.subtitle')}</small></div></li></ol><div className="image-build-list">{RUNTIMES.map((item) => {
                  const image = status?.runtimes?.find((entry) => entry.id === item.id);
                  return <div className="image-build-row" key={item.id}><div><strong>{item.name}</strong><small title={image?.image}>{image?.installed ? t('guide.image.ready') : image ? t('guide.image.needBuild') : t('guide.image.unknown')}</small></div><button type="button" className="button small" onClick={() => buildImage(item.id)} disabled={!!building || !status?.docker || !!busy || chatting}>{building === item.id ? <><Icon name="refresh" className="spinning" size={13} />{t('guide.image.building')}</> : image?.installed ? t('guide.image.rebuild') : t('guide.image.build')}</button></div>;
                })}</div><p className="guide-footnote">{t('guide.footnote')}</p>{buildLabel && <a className="build-log-link" href="#build-console">{t('guide.logLink')} <Icon name="arrow" size={13} /></a>}</div>
                <div className="development-note"><div className="note-icon"><Icon name="box" size={20} /></div><h3>{t('guide.dev.title')}</h3><p>{renderLines(t('guide.dev.body1'))}</p><p>{t('guide.dev.body2')}</p><span>{t('guide.dev.footer')} <Icon name="arrow" size={14} /></span></div>
              </aside>}
            </div> : <section className="chat-panel" aria-label={t('tabs.chat')}>
              <div className="chat-toolbar"><div><strong>{chatSession?.title || t('chat.workspaceTitle')}</strong><span>{activeAgent ? t('chat.activeAgent', { agent: activeAgent.name, runtime: runtimeById(activeAgent.runtime)?.name || activeAgent.runtime }) : t('chat.selectAgentHint')}</span></div><div className="inline-actions">{chatSession && <button className="button small danger-button" type="button" onClick={() => setSessionDeleteConfirm(true)} disabled={!!busy || chatting}><Icon name="trash" size={14} />{t('chat.deleteSession')}</button>}<button className="button small" type="button" onClick={createSession} disabled={!!busy || chatting}><Icon name="plus" size={14} />{t('chat.newSession')}</button></div></div>
              {sessionDeleteConfirm && chatSession && <div className="notice warning" role="alert"><div><strong>{t('chat.deleteSessionConfirmTitle', { title: chatSession.title })}</strong>{t('chat.deleteSessionConfirmBody')}</div><div className="inline-actions"><button className="button small" type="button" onClick={() => setSessionDeleteConfirm(false)} disabled={!!busy}>{t('chat.deleteSessionCancel')}</button><button className="button small danger-button" type="button" onClick={deleteSession} disabled={!!busy}>{busy === 'delete-session' ? t('chat.deletingSession') : t('chat.deleteSessionConfirm')}</button></div></div>}
              {!chatSession ? <div className="chat-empty"><span className="empty-orbit"><Icon name="chat" size={34} /></span><h3>{t('chat.noSessionTitle')}</h3><p>{t('chat.noSessionBody')}</p><button className="button primary" onClick={createSession} disabled={!!busy}><Icon name="plus" size={15} />{t('chat.newSession')}</button></div> : <>
                <ErrorNotice>{historyErrorText}</ErrorNotice>
                {historyErrorText && <button className="text-button history-retry" onClick={() => setHistoryVersion((value) => value + 1)} disabled={chatting || historyLoading}>{t('chat.historyRetry')}</button>}
                <div className="messages" role="log" aria-label={t('chat.logAria')} aria-busy={historyLoading}>
                  {historyLoading && !messages.length ? <div className="chat-empty"><p>{t('chat.historyLoading')}</p></div> : !messages.length ? <div className="chat-empty"><span className="empty-orbit"><Icon name="chat" size={28} /></span><h3>{t('chat.sessionEmptyTitle')}</h3><p>{t('chat.sessionEmptyBody')}</p><div className="agent-mention-list">{agents.map((agent) => <button type="button" className="button small" key={agent.id} onClick={() => setPrompt(`@${agent.name} `)} disabled={chatting}><span className={`runtime-symbol ${agent.runtime}`}>{runtimeById(agent.runtime)?.mark}</span>@{agent.name}</button>)}</div></div> : messages.map((message, index) => {
                    const messageAgent = agents.find((agent) => agent.id === message.agentId);
                    const agentName = message.agentName || messageAgent?.name || t('chat.agentDeleted');
                    return <article className={`message ${message.role}`} key={index}><span className="message-avatar">{message.role === 'user' ? t('chat.role.user') : message.role === 'error' ? '!' : runtimeById(messageAgent?.runtime)?.mark || 'A'}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? `${t('chat.role.user')} → ${agentName}` : message.role === 'error' ? `${t('chat.role.error')} · ${agentName}` : agentName}</strong>{message.createdAt && <time dateTime={message.createdAt}>{messageFormatter.format(new Date(message.createdAt))}</time>}</div><div className="message-content">{message.content || (message.streaming ? t('chat.message.waiting') : t('chat.message.empty'))}{message.streaming && message.content && <span className="stream-cursor" aria-hidden="true" />}</div><ArtifactCards agentId={message.agentId} artifacts={message.artifacts} onPreview={setArtifactPreview} /></div></article>;
                  })}
                  <div ref={bottom} />
                </div>
                <div className="chat-composer">
                  <ErrorNotice>{chatErrorText}</ErrorNotice>
                  <div className="chat-live-status" role="status">{chatStatusText && <><span className={`dot ${chatting ? 'success-dot' : ''}`} />{chatStatusText}</>}</div>
                  <form onSubmit={send}>
                    <label className="visually-hidden" htmlFor="prompt">{t('chat.composer.label')}</label>
                    <div className="mention-composer">
                      {mentionSuggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label={t('chat.mentionSuggestions')}>{mentionSuggestions.map((agent) => <button type="button" role="option" key={agent.id} onClick={() => setPrompt(`@${agent.name} `)}><span className={`runtime-symbol ${agent.runtime}`}>{runtimeById(agent.runtime)?.mark}</span><span><strong>{agent.name}</strong><small>{runtimeById(agent.runtime)?.name}</small></span></button>)}</div>}
                      <textarea id="prompt" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={activeAgent ? t('chat.composer.placeholder.sticky', { agent: activeAgent.name }) : t('chat.composer.placeholder.mention')} disabled={chatting || cancelling} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} />
                    </div>
                    <div className="composer-bottom"><span><span className="dot" />{activeAgent ? t('chat.stickyAgent', { agent: activeAgent.name }) : t('chat.noAgent')}<span className="keyboard-hint">{t('chat.composer.shortcut')}</span></span>{chatting ? <button className="button" type="button" onClick={cancelChat} disabled={cancelling}><Icon name="stop" size={15} />{cancelling ? t('chat.composer.stopping') : t('chat.composer.stop')}</button> : <button className="button primary" type="submit" disabled={!prompt.trim() || !!busy || cancelling || historyLoading || !!historyError}><span>{t('chat.composer.send')}</span><Icon name="send" size={16} /></button>}</div>
                  </form>
                  <p className="chat-disclaimer">{t('chat.sessionDisclaimer')}</p>
                </div>
              </>}
            </section>}
          </section>
          {visibleBuildConsole && <section id="build-console" className="build-console" aria-label={t('build.console.title', { runtime: buildRuntime?.name || buildConsole.runtimeId, phase: t(`build.console.${buildConsole.phase}`) })}><div className="console-heading"><span><Icon name="terminal" size={17} /><strong>{buildLabel}</strong>{buildConsole.phase === 'building' && <span className="badge"><span className="dot success-dot" />{t('build.console.live')}</span>}</span><small>{t('build.console.limit')}</small></div>          <ErrorNotice>{buildErrorText}</ErrorNotice><pre ref={logs} tabIndex={0} aria-label={t('build.console.title', { runtime: buildRuntime?.name || buildConsole.runtimeId, phase: t(`build.console.${buildConsole.phase}`) })}>{buildLog || (buildConsole.phase === 'building' ? t('build.console.connecting') : t('build.console.noLogs'))}</pre></section>}
          <footer className="page-footer"><span>{t('footer.left')}</span><span>{t('footer.right')}</span></footer>
        </main>
      </div>
      <ArtifactPreview value={artifactPreview} onClose={() => setArtifactPreview(null)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<I18nProvider><App /></I18nProvider>);
