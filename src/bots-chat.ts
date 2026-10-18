import { escape, icon, markdownHtml } from './dom';
import type { Bot } from './bots';
import type { Message, MessagePage } from './types';

/** What the workspace knows about a running turn: streamed text, status and open approvals. */
export interface LiveTurn { text: string; status: string; approvals: [string, string][] }
export interface ChatHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  running(sessionId: string): boolean;
  live(sessionId: string): LiveTurn | null;
  notify(text: string): void;
  openTask(sessionId: string): void;
  /** The desktop conversation was created by the first message. */
  started(sessionId: string): void;
  approve(sessionId: string, requestId: string, approved: boolean): Promise<void>;
  /** Offer "Open in workspace"; off where the chat already is the workspace. */
  showOpen?: boolean;
  /** Getting-started steps shown while the conversation is empty; each opens its setting. */
  setup?(): { id: string; label: string; detail: string; done: boolean }[];
  openSetup?(id: string): void;
  /** Composer chips under the prompt, like a task's model and mode pickers. */
  toolbar?(): string;
}
export interface ChatView { update(): void; reload(): Promise<void>; dispose(): void }

const drafts = new Map<string, string>();
const CONTEXT = ['\n\nBot brief:', '\n\nDocument context:', '\n\nFolder context:', '\n\nFile context:'];
export function visible(text: string): string {
  const cut = Math.min(...CONTEXT.map(marker => text.indexOf(marker)).filter(index => index >= 0), text.length);
  return text.slice(0, cut).trim();
}
export function suggestions(bot: Bot): string[] {
  return [
    'What can you do for me?',
    `Remember that I like short, direct answers`,
    bot.heartbeatMinutes ? 'What will you check on in your next check-in?' : 'Every weekday at 9:00, send me a summary of what changed',
  ];
}

export function mountChat(host: HTMLElement, bot: Bot, initialSession: string | null, chat: ChatHost): ChatView {
  let sessionId = initialSession;
  let messages: Message[] = [];
  let pending: string[] = [];
  let sending = false, disposed = false, frame = 0, request = 0;
  const rendered = new Map<number, string>();
  host.innerHTML = `<div class="bots-convo" role="log" aria-label="Conversation with ${escape(bot.name)}" aria-live="polite"></div>
    <form class="bots-chat"><textarea name="text" rows="1" maxlength="32000" aria-label="Message ${escape(bot.name)}" placeholder="${bot.paused ? `${escape(bot.name)} is paused. Resume to send.` : `Message ${escape(bot.name)}`}" title="Enter to send · Shift-Enter for a new line · /stop interrupts · /new starts over"></textarea>
    <div class="bots-chat-toolbar"><div class="bots-chat-tools">${chat.toolbar?.() ?? ''}</div><div class="bots-chat-actions">
    ${sessionId && chat.showOpen !== false ? `<button type="button" class="bots-link" data-open-task="${escape(sessionId)}">Open in workspace${icon('forward')}</button>` : ''}
    <button type="submit" class="send-button bots-send" aria-label="Send" title="Send (Enter)" ${bot.paused ? 'disabled' : ''}>${icon('arrow')}</button></div></div></form>`;
  const log = host.querySelector<HTMLElement>('.bots-convo')!;
  const form = host.querySelector<HTMLFormElement>('.bots-chat')!;
  const input = form.querySelector<HTMLTextAreaElement>('textarea')!;
  input.value = drafts.get(bot.id) ?? '';
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; };
  grow();

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  function bubble(role: string, html: string, cls = ''): string {
    // Like a task's transcript: your messages in a bubble, the bot's as plain Markdown.
    return `<div class="bots-msg ${role === 'user' ? 'me' : 'bot'} ${cls}"><div class="bots-msg-body ${role === 'user' ? '' : 'markdown'}">${html}</div></div>`;
  }
  function empty(): string {
    const steps = chat.setup?.() ?? [];
    const open = steps.filter(step => !step.done);
    const checklist = open.length ? `<div class="bots-setup" role="group" aria-label="Set up ${escape(bot.name)}"><span class="bots-setup-title">Set up · ${steps.length - open.length} of ${steps.length} done</span>${steps.map(step => `<button type="button" class="bots-setup-step ${step.done ? 'done' : ''}" data-setup="${escape(step.id)}" ${step.done ? 'aria-disabled="true"' : ''}><span class="bots-setup-check" aria-hidden="true"></span><span><b>${escape(step.label)}</b><small>${escape(step.detail)}</small></span>${step.done ? '' : icon('forward')}</button>`).join('')}</div>` : '';
    return `<div class="bots-hello"><span class="bot-avatar large" aria-hidden="true">${escape(bot.avatar.trim() || bot.name.slice(0, 1).toUpperCase())}</span><b>Say hi to ${escape(bot.name)}</b><p>${escape(bot.role || 'Your always-on assistant')}</p>
      ${checklist}<div class="bots-suggestions" role="group" aria-label="Try asking">${suggestions(bot).map(text => `<button type="button" data-suggest="${escape(text)}">${escape(text)}</button>`).join('')}</div></div>`;
  }
  async function html(message: Message): Promise<string> {
    const text = message.role === 'user' ? visible(message.content) : message.content;
    const key = `${message.id}:${text.length}`;
    const cached = rendered.get(message.id);
    if (cached?.startsWith(key + '|')) return cached.slice(key.length + 1);
    const out = message.role === 'user' ? escape(text).replaceAll('\n', '<br>') : await markdownHtml(text);
    rendered.set(message.id, `${key}|${out}`);
    return out;
  }
  async function paint(): Promise<void> {
    const stick = nearBottom();
    const shown = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim());
    const tools = (index: number) => {
      // Tool rows between two shown messages collapse into one quiet line.
      const from = messages.indexOf(shown[index]), to = index + 1 < shown.length ? messages.indexOf(shown[index + 1]) : messages.length;
      const count = messages.slice(from + 1, to).filter(message => message.role === 'tool').length;
      return count ? `<div class="bots-tools">${icon('terminal')}Used ${count} ${count === 1 ? 'tool' : 'tools'}</div>` : '';
    };
    const parts = await Promise.all(shown.map(async (message, index) => bubble(message.role, await html(message)) + tools(index)));
    if (disposed) return;
    const live = sessionId ? chat.live(sessionId) : null;
    const running = sessionId ? chat.running(sessionId) : false;
    const waiting = pending.map(text => bubble('user', escape(text).replaceAll('\n', '<br>'), 'sending'));
    const streamed = live?.text.trim() ? bubble('assistant', await markdownHtml(live.text), 'live') : '';
    const approvals = (live?.approvals ?? []).map(([id, text]) => `<div class="bots-approval" data-request="${escape(id)}">${icon('unlock')}<div><b>${escape(bot.name)} wants to</b><p>${escape(text)}</p><div class="bots-approval-actions"><button type="button" class="primary-button" data-approve="${escape(id)}">Allow once</button><button type="button" class="secondary-button" data-deny="${escape(id)}">Deny</button></div></div></div>`);
    const typing = (running || pending.length) && !live?.approvals.length ? `<div class="bots-typing" role="status"><span class="bots-dots" aria-hidden="true"><i></i><i></i><i></i></span>${escape(live?.status && live.status !== 'Working' ? live.status : `${bot.name} is working`)}</div>` : '';
    if (disposed) return;
    log.innerHTML = parts.length || waiting.length || streamed ? parts.join('') + waiting.join('') + streamed + approvals.join('') + typing : empty();
    // An empty conversation reads from the top; a running one follows its newest message.
    if (!parts.length && !waiting.length && !streamed) log.scrollTop = 0;
    else if (stick || pending.length) log.scrollTop = log.scrollHeight;
  }
  async function reload(): Promise<void> {
    const id = ++request;
    if (sessionId) {
      try {
        const page = await chat.call<MessagePage>('get_messages', { sessionId });
        if (disposed || id !== request) return;
        messages = page.messages;
        // A pending bubble disappears once its prompt is saved.
        pending = pending.filter(text => !messages.some(message => message.role === 'user' && visible(message.content) === text.trim()));
      } catch { if (!disposed) messages = []; }
    }
    await paint();
  }
  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || sending || bot.paused) return;
    sending = true; pending = [...pending, message]; input.value = ''; drafts.delete(bot.id); grow();
    void paint();
    try {
      const id = await chat.call<string>('bot_message', { botId: bot.id, text: message });
      if (sessionId !== id) { sessionId = id; chat.started(id); }
      await reload();
    } catch (cause) {
      pending = pending.filter(item => item !== message);
      input.value = message; grow();
      chat.notify(cause instanceof Error ? cause.message : String(cause));
      void paint();
    } finally { sending = false; }
  }
  const onSubmit = (event: SubmitEvent) => { event.preventDefault(); event.stopPropagation(); void send(input.value); };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(input.value); } };
  const onInput = () => { drafts.set(bot.id, input.value); grow(); };
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || !host.contains(target) || target.disabled) return;
    if (target.dataset.suggest) { event.stopPropagation(); void send(target.dataset.suggest); return; }
    if (target.dataset.setup) { event.stopPropagation(); if (target.getAttribute('aria-disabled') !== 'true') chat.openSetup?.(target.dataset.setup); return; }
    const id = target.dataset.approve ?? target.dataset.deny;
    if (id && sessionId) {
      event.stopPropagation();
      target.closest('.bots-approval')?.querySelectorAll('button').forEach(button => { button.disabled = true; });
      void chat.approve(sessionId, id, Boolean(target.dataset.approve))
        .then(() => paint())
        .catch(cause => { chat.notify(cause instanceof Error ? cause.message : String(cause)); void paint(); });
    }
  };
  form.addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onKey);
  input.addEventListener('input', onInput);
  host.addEventListener('click', onClick);
  void reload();
  return {
    update: () => { if (frame || disposed) return; frame = requestAnimationFrame(() => { frame = 0; void paint(); }); },
    reload,
    dispose: () => {
      disposed = true; cancelAnimationFrame(frame);
      form.removeEventListener('submit', onSubmit); input.removeEventListener('keydown', onKey); input.removeEventListener('input', onInput); host.removeEventListener('click', onClick);
    },
  };
}
