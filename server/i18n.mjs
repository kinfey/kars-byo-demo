export const supportedLocales = ['zh-CN', 'en'];

export function resolveLocale(header = '') {
  const preferences = String(header).split(',').map((entry, index) => {
    const [tag, ...params] = entry.trim().split(';');
    const q = params.find(param => param.trim().startsWith('q='));
    return { tag: tag.toLowerCase(), quality: q ? Number(q.trim().slice(2)) : 1, index };
  }).filter(item => item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of preferences) {
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN';
  }
  return 'zh-CN';
}

export const messages = {
  'Invalid agent ID': 'Agent ID 无效',
  'Expected an agent configuration object': '请提供有效的 Agent 配置对象',
  'Select claude, copilot or codex': '请选择 Claude、Copilot 或 Codex 运行时',
  'Create a new agent to change its runtime': '如需更换运行时，请创建新的 Agent',
  'Changing runtime requires a matching credential': '更换运行时需要填写对应的凭据',
  'Agent name is required': '请填写 Agent 名称',
  'Model is invalid': '模型名称无效',
  'Copilot runtime uses gpt-6-astra': 'Copilot 运行时固定使用 gpt-6-astra',
  'API base URL must be HTTP(S), without credentials, query or fragment': 'API Base URL 必须使用 HTTP(S)，且不能包含凭据、查询参数或片段',
  'Credential must be a single line': '凭据必须是单行文本',
  'MCP servers must be an object with at most 20 servers': 'MCP 配置必须是对象，且最多包含 20 个服务',
  'Invalid MCP server name/configuration': 'MCP 服务名称或配置无效',
  'Invalid MCP HTTP URL': 'MCP HTTP 地址无效',
  'Only streamable HTTP and stdio MCP are supported': '仅支持 Streamable HTTP 和 stdio MCP',
  'MCP stdio servers require a command': 'stdio MCP 服务必须配置 command',
  'MCP args must be strings': 'MCP args 必须是字符串数组',
  'MCP configuration is too large': 'MCP 配置内容过长',
  'At most 30 skills are allowed': '最多可添加 30 个 Skill',
  'Skill names must be unique lowercase slugs': 'Skill 名称必须唯一，并使用小写字母、数字和连字符',
  'Skill content is required': '请填写 Skill 内容',
  'Skill file must be a ZIP archive': 'Skill 文件必须是 ZIP 压缩包',
  'Skill file name is invalid': 'Skill 文件名无效',
  'Skill ZIP is empty': 'Skill ZIP 不能为空',
  'Skill ZIP exceeds 5 MiB': 'Skill ZIP 不能超过 5 MiB',
  'Content-Type application/zip is required': 'Skill 上传必须使用 Content-Type: application/zip',
  'tools must be boolean': '工具开关必须是布尔值',
  'Content-Type application/json is required': '请求必须使用 Content-Type: application/json',
  'Request is too large': '请求内容过长',
  'Invalid JSON': 'JSON 格式无效',
  'Invalid URL': 'URL 地址无效',
  'fetch failed': '连接失败，请检查本地服务或运行时是否正在运行',
  'Agent is busy; cancel its current operation first': 'Agent 正在执行操作，请先取消当前操作',
  'Prompt must contain 1–64000 characters': '消息长度必须在 1–64000 个字符之间',
  'Agent already has an active operation': 'Agent 已有正在执行的操作',
  'Chat client disconnected': '对话客户端已断开连接',
  'Start the agent container before chatting': '请先启动 Agent 容器，再开始对话',
  'Conversation is too large; create a new agent for a fresh workspace/session': '对话内容过长，请创建新 Agent 以开始新的工作区或会话',
  'Runtime stream ended without completion': '运行时连接提前结束，未收到完成事件',
  'Chat cancelled': '对话已取消',
  'Only local requests are allowed': '仅允许本地请求',
  'Cross-origin request denied': '跨站请求已被拒绝',
  'Unknown runtime': '未知的运行时',
  'Another image build is already running': '已有镜像正在构建，请等待完成',
  'Runtime lifecycle is managed by KARS on AKS; Docker is intentionally unavailable in ACA': '运行时生命周期由 AKS 上的 KARS 管理；ACA 中不会运行 Docker',
  'Runtime lifecycle is managed by KARS on AKS': '运行时生命周期由 AKS 上的 KARS 管理',
  'Image builds are managed by KARS on AKS': '镜像构建由 AKS 上的 KARS 管理',
  'Cloud dev currently supports GitHub Copilot CLI only': 'Cloud dev 当前仅支持 GitHub Copilot CLI',
  'Running KARS runtime on AKS': '正在调用 AKS 上的 KARS runtime',
  'KARS chat endpoint is not configured': '尚未配置 KARS 对话地址',
  'KARS chat endpoint must be an HTTPS URL without credentials, query or fragment': 'KARS 对话地址必须是无凭据、查询参数或片段的 HTTPS URL',
  'KARS response stream is unavailable': 'KARS 响应流不可用',
  'KARS response exceeded 4 MiB': 'KARS 响应超过 4 MiB 限制',
  'KARS response stream ended without completion': 'KARS 响应流提前结束',
  'KARS completed without an assistant response': 'KARS 已完成请求，但没有返回助手回复',
  'Endpoint not found': '接口不存在',
  'Method not allowed': '不支持此请求方法',
  'Invalid path': '路径无效',
  'Runtime health endpoint did not become ready': '运行时健康检查未就绪',
  'CLI provider request failed; check model, endpoint, and credentials': '模型请求失败，请检查模型、服务地址和凭据',
  'CLI run failed; check provider configuration and credentials': 'CLI 执行失败，请检查服务配置和凭据',
  'CLI returned malformed structured output': 'CLI 返回了无效的结构化数据',
  'CLI completed without an assistant response': 'CLI 已结束，但没有返回助手回复',
  'CLI output exceeded 4 MiB': 'CLI 输出超过 4 MiB 限制',
  'Claude Code CLI assistant response exceeded 4 MiB': 'Claude Code CLI 助手回复超过 4 MiB 限制',
  'CLI event exceeded size limit': 'CLI 事件超过长度限制',
  'Agent run timed out': 'Agent 执行超时',
  'Unable to start the configured CLI': '无法启动配置的 CLI',
  'Agent runtime failed': 'Agent 运行时执行失败',
  'An agent run is already active': 'Agent 已有正在执行的任务',
  'Configure a provider credential before starting a chat': '请先配置模型服务凭据，再开始对话',
  'Request body timed out': '读取请求内容超时',
  'Expected application/json': '请求必须使用 application/json 格式',
  'Request exceeds 256 KiB': '请求内容超过 256 KiB 限制',
  'Unauthorized': '未通过身份验证',
  'Not found': '请求的资源不存在',
  'Read-only mode: shell, file-edit, image-read, MCP, and interactive tools disabled by native CLI configuration.': '只读模式：已通过 CLI 原生配置禁用命令、文件编辑、图片读取、MCP 和交互工具。',
};

const fields = {
  name: '名称', model: '模型', baseUrl: 'API Base URL', credential: '凭据',
  instructions: '指令', 'Skill description': 'Skill 描述', 'Skill content': 'Skill 内容',
};

export function localizeMessage(message, locale = 'zh-CN') {
  if (typeof message !== 'string') return message;
  const canonical = Object.keys(messages).find(key => messages[key] === message) ?? message;
  if (locale === 'en') {
    if (messages[canonical]) return canonical;
  } else if (messages[canonical]) return messages[canonical];
  const english = locale === 'en';
  let match = canonical.match(/^Missing (GitHub Copilot Token|API Key)\. Open Configure, save your credential, and restart the container before chatting\.$/);
  if (match) return english ? canonical : `尚未配置 ${match[1]}。请进入「配置构建」填写并保存凭据，重新启动容器后再发送消息。`;
  match = canonical.match(/^尚未配置 (GitHub Copilot Token|API Key)。请进入「配置构建」填写并保存凭据，重新启动容器后再发送消息。$/);
  if (match) return english ? `Missing ${match[1]}. Open Configure, save your credential, and restart the container before chatting.` : canonical;
  match = canonical.match(/^Missing (GitHub Copilot Token|API Key)\. Open Configure and save your credential before chatting\.$/);
  if (match) return english ? canonical : `尚未配置 ${match[1]}。请进入「配置构建」填写并保存凭据后再发送消息。`;
  match = canonical.match(/^尚未配置 (GitHub Copilot Token|API Key)。请进入「配置构建」填写并保存凭据后再发送消息。$/);
  if (match) return english ? `Missing ${match[1]}. Open Configure and save your credential before chatting.` : canonical;
  match = canonical.match(/^(.+) must be a string of at most (\d+) characters$/);
  if (match) return english ? canonical : `${fields[match[1]] ?? match[1]}必须是最多 ${match[2]} 个字符的字符串`;
  match = canonical.match(/^MCP (env|headers) must map names to strings$/);
  if (match) return english ? canonical : `MCP ${match[1]} 必须是名称到字符串的映射`;
  match = canonical.match(/^Starting (.+)…$/);
  if (match) return english ? canonical : `正在启动 ${match[1]}…`;
  match = canonical.match(/^Running (claude|copilot|codex) CLI \(local-direct\)$/);
  if (match) return english ? canonical : `正在运行 ${match[1]} CLI（本地直连）`;
  match = canonical.match(/^GitHub Copilot CLI (.+) loaded in KARS$/);
  if (match) return english ? canonical : `GitHub Copilot CLI ${match[1]} 已在 KARS 中成功加载`;
  match = canonical.match(/^(Claude Code CLI|Codex CLI) (.+) loaded in KARS$/);
  if (match) return english ? canonical : `${match[1]} ${match[2]} 已在 KARS 中成功加载`;
  match = canonical.match(/^(Running tool|Tool finished|Tool failed): (.+)$/);
  if (match) return english ? canonical : `${{ 'Running tool': '正在执行工具', 'Tool finished': '工具执行完成', 'Tool failed': '工具执行失败' }[match[1]]}：${match[2]}`;
  match = canonical.match(/^Synchronizing Skill: (.+)$/);
  if (match) return english ? canonical : `正在同步 Skill：${match[1]}`;
  match = canonical.match(/^Runtime HTTP (\d+): ([\s\S]*)$/);
  if (match) return english ? canonical : `运行时 HTTP ${match[1]}：${localizeMessage(match[2], locale)}`;
  match = canonical.match(/^Docker (\S+) failed([\s\S]*)$/);
  if (match) return english ? canonical : `Docker ${match[1]} 执行失败${match[2]}`;
  return canonical;
}

export function messageTranslations(message) {
  const english = localizeMessage(message, 'en');
  const chinese = localizeMessage(message, 'zh-CN');
  return english === chinese ? undefined : { en: english, 'zh-CN': chinese };
}
