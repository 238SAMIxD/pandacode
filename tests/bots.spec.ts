import { expect, test, type Page } from '@playwright/test';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Bots' });
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name, exact: false });

/** Records links opened and text copied, instead of leaving the page. */
async function captureOutside(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any; w.__opened = []; w.__copied = [];
    window.open = ((url: string) => { w.__opened.push(String(url)); return null; }) as typeof window.open;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { w.__copied.push(text); } } });
  });
}
const opened = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__opened);
const copied = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__copied);

const sidebar = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });
async function openBots(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Add bot', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

async function createBot(page: Page, name = 'Scout'): Promise<void> {
  await dialog(page).getByRole('button', { name: /Researcher/ }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(dialog(page).getByRole('heading', { name, level: 3 })).toBeVisible();
}

test.describe('bots', () => {
  test('bots start with a template form, then open on Chat', async ({ page }) => {
    await openBots(page);
    await expect(dialog(page).getByRole('heading', { name: 'New bot' })).toBeVisible();
    await expect(dialog(page).getByText('No bots yet.')).toBeVisible();
    await dialog(page).getByRole('button', { name: /Researcher/ }).click();
    await expect(dialog(page).getByRole('textbox', { name: 'Job' })).toHaveValue('Digs into questions and reports back');
    await dialog(page).getByRole('textbox', { name: 'Name' }).fill('');
    await dialog(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('Give the bot a name.');
    await createBot(page);
    await expect(tab(page, 'Chat')).toHaveAttribute('aria-selected', 'true');
    await expect(dialog(page).getByRole('button', { name: /Scout/ }).first()).toHaveAttribute('aria-current', 'true');
    await expect(dialog(page).getByText('Say hi to Scout')).toBeVisible();
    // The bot lives in the sidebar's Bots section, not among projects.
    await page.keyboard.press('Escape');
    await expect(sidebar(page).getByRole('button', { name: 'Chat with Scout' })).toBeVisible();
    await expect(page.locator('#navigation')).not.toContainText('Scout');
  });

  test('chatting with a bot streams its reply in the window', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    const convo = dialog(page).getByRole('log', { name: 'Conversation with Scout' });
    await expect(convo.getByText('Say hi to Scout')).toBeVisible();
    await dialog(page).getByRole('textbox', { name: 'Message Scout' }).fill('What changed in the repo today?');
    await dialog(page).getByRole('textbox', { name: 'Message Scout' }).press('Enter');
    await expect(convo.locator('.bots-msg.me')).toContainText('What changed in the repo today?');
    await expect(dialog(page).getByRole('textbox', { name: 'Message Scout' })).toHaveValue('');
    // The sample agent answers; the reply lands as a bot bubble and the typing row clears.
    await expect(convo.locator('.bots-msg.bot').last()).not.toBeEmpty({ timeout: 15_000 });
    await expect(convo.locator('.bots-typing')).toHaveCount(0, { timeout: 15_000 });
    await expect(convo.locator('.bots-msg.me')).toHaveCount(1);
    await dialog(page).getByRole('button', { name: /Open in workspace/ }).click();
    await expect(dialog(page)).toBeHidden();
    // The bot's own conversation opens as its page, not as a plain task transcript.
    await expect(page.locator('#bot-page .bots-msg.me')).toContainText('What changed in the repo today?');
    await expect(sidebar(page).locator('.bot-row.selected')).toContainText('Scout');
  });

  test('suggestions send a first message and keep drafts per bot', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    const input = dialog(page).getByRole('textbox', { name: 'Message Scout' });
    await input.fill('half-written thought');
    await tab(page, 'Memory').click();
    await tab(page, 'Chat').click();
    await expect(input).toHaveValue('half-written thought');
    await input.fill('');
    await dialog(page).getByRole('button', { name: 'What can you do for me?' }).click();
    await expect(dialog(page).locator('.bots-msg.me')).toContainText('What can you do for me?');
    await expect(dialog(page).locator('.bots-stats')).toContainText('memories');
  });

  test('memories can be added and forgotten', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    await tab(page, 'Memory').click();
    const input = dialog(page).getByRole('textbox', { name: 'New memory' });
    await input.fill('I prefer metric units');
    await dialog(page).getByRole('button', { name: 'Remember' }).click();
    await expect(dialog(page).getByText('I prefer metric units')).toBeVisible();
    await expect(dialog(page).getByText('Added by you', { exact: false })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Forget this memory' }).click();
    await expect(dialog(page).getByText('No memories yet.')).toBeVisible();
  });

  test('schedules show their timing and can be turned off, run and deleted', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    await tab(page, 'Schedules').click();
    await dialog(page).getByRole('textbox', { name: 'What should it do?' }).fill('Summarize my notifications');
    await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Morning digest');
    await dialog(page).getByRole('combobox', { name: 'Repeat' }).selectOption('weekdays');
    await expect(dialog(page).getByLabel('Time')).toBeVisible();
    await expect(dialog(page).getByLabel('Every (minutes)')).toBeHidden();
    await dialog(page).getByRole('button', { name: 'Add schedule' }).click();
    const row = dialog(page).locator('.bots-items li', { hasText: 'Morning digest' });
    await expect(row).toContainText('Weekdays at 09:00');
    await row.getByRole('checkbox', { name: 'Morning digest on' }).uncheck();
    await expect(row).toHaveClass(/off/);
    await row.getByRole('button', { name: 'Run Morning digest now' }).click();
    await row.getByRole('button', { name: 'Delete Morning digest' }).click();
    await expect(dialog(page).getByText('No schedules yet.', { exact: false })).toBeVisible();
  });

  test('Telegram setup walks through BotFather, catches a bad token, and pairs the first sender', async ({ page }) => {
    await captureOutside(page);
    await openBots(page);
    await createBot(page);
    await tab(page, 'Channels').click();
    await dialog(page).getByRole('button', { name: /^Telegram/ }).click();
    const form = dialog(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(3);
    await form.getByRole('button', { name: 'Open BotFather' }).click();
    await expect.poll(() => opened(page)).toEqual(['https://t.me/BotFather']);
    await form.getByRole('button', { name: 'Copy' }).first().click();
    await expect.poll(() => copied(page)).toEqual(['/newbot']);
    await form.getByLabel('Bot token').fill('123456');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('copy the whole line BotFather sent');
    await form.getByLabel('Bot token').fill('123456789:AAE1234567890abcdefghijklmnopqrstu');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.ok')).toContainText('@preview_pandacode_bot');
    await form.getByRole('button', { name: 'Connect Telegram' }).click();
    const card = dialog(page).locator('.bots-channel');
    await expect(card).toContainText('@preview_pandacode_bot');
    await expect(dialog(page)).not.toContainText('AAE1234567890');
    const guide = card.locator('details.bots-guide');
    await expect(guide).toHaveAttribute('open', '');
    await guide.getByRole('button', { name: 'Open @preview_pandacode_bot in Telegram' }).click();
    await expect.poll(async () => (await opened(page)).at(-1)).toBe('https://t.me/preview_pandacode_bot');
    const pending = dialog(page).locator('.bots-pairing.pending');
    await expect(pending).toContainText('4821');
    await expect(tab(page, 'Channels')).toContainText('1');
    await pending.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog(page).locator('.bots-pairing')).toContainText('approved');
    await expect(card.locator('details.bots-guide')).not.toHaveAttribute('open', '');
    await dialog(page).getByRole('button', { name: 'Remove Telegram' }).click();
    await dialog(page).getByRole('alertdialog', { name: 'Remove this channel?' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog(page).locator('.bots-channel')).toHaveCount(0);
  });

  test('Slack setup creates the app from a prefilled manifest and spots swapped tokens', async ({ page }) => {
    await captureOutside(page);
    await openBots(page);
    await createBot(page);
    await tab(page, 'Channels').click();
    await dialog(page).getByRole('button', { name: /^Slack/ }).click();
    const form = dialog(page).locator('.bots-connect');
    await form.getByRole('button', { name: 'Create Slack app' }).click();
    await expect.poll(async () => (await opened(page)).length).toBe(1);
    const url = new URL((await opened(page))[0]);
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(manifest.display_information.name).toBe('Scout');
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im']);
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining(['chat:write', 'app_mentions:read', 'im:history', 'users:read']));
    await form.getByRole('button', { name: 'Copy manifest instead' }).click();
    await expect.poll(async () => (await copied(page)).length).toBe(1);
    expect(JSON.parse((await copied(page))[0])).toEqual(manifest);
    await form.getByLabel('Bot token').fill('xapp-1-A');
    await form.getByLabel('App-level token').fill('xoxb-1-B');
    await form.getByRole('button', { name: 'Connect Slack' }).click();
    await expect(dialog(page).getByRole('alert').first()).toContainText('swapped');
    // Typed values survive the panel re-rendering.
    await tab(page, 'Memory').click();
    await tab(page, 'Channels').click();
    await expect(form.getByLabel('Bot token')).toHaveValue('xapp-1-A');
    await form.getByLabel('Bot token').fill('xoxb-1-B');
    await form.getByLabel('App-level token').fill('xapp-1-A');
    await form.getByRole('button', { name: 'Connect Slack' }).click();
    await expect(dialog(page).locator('.bots-channel')).toContainText('@scout in Preview Workspace');
    await expect(dialog(page).locator('.bots-guide')).toContainText('/invite');
  });

  test('Discord setup offers the server invite and warns when Message Content is off', async ({ page }) => {
    await captureOutside(page);
    await openBots(page);
    await createBot(page);
    await tab(page, 'Channels').click();
    await dialog(page).getByRole('button', { name: /^Discord/ }).click();
    const form = dialog(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(4);
    await form.getByLabel('Bot token').fill('client-secret-by-mistake');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('Client Secret');
    await form.getByLabel('Bot token').fill(`${'M'.repeat(24)}.${'G'.repeat(6)}.${'x'.repeat(38)}`);
    await form.getByRole('button', { name: 'Connect Discord' }).click();
    const card = dialog(page).locator('.bots-channel');
    await expect(card.locator('.bots-warning')).toContainText('Message Content intent is off');
    await card.getByRole('button', { name: 'Add to a server' }).click();
    await expect.poll(async () => (await opened(page)).at(-1) ?? '').toContain('discord.com/oauth2/authorize?client_id=1234567890&scope=bot');
  });

  test('WhatsApp setup ends with copyable webhook details built from the tunnel address', async ({ page }) => {
    await captureOutside(page);
    await openBots(page);
    await createBot(page);
    await tab(page, 'Channels').click();
    await dialog(page).getByRole('button', { name: /^WhatsApp/ }).click();
    const form = dialog(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(5);
    await form.getByLabel('Phone number ID').fill('+351 912 345 678');
    await form.getByLabel('Access token').fill('EAAG-preview');
    await form.getByLabel('App secret').fill('preview-secret');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('not the phone number itself');
    await form.getByLabel('Phone number ID').fill('123456789012345');
    await form.getByRole('button', { name: 'Connect WhatsApp' }).click();
    const guide = dialog(page).locator('.bots-channel .bots-guide');
    await expect(guide).toContainText('cloudflared tunnel --url http://127.0.0.1:47321');
    await expect(guide).toContainText('the callback URL appears here after you save the address');
    await expect(guide).toContainText('pandacode-preview0123456789');
    await guide.getByPlaceholder('https://….trycloudflare.com').fill('http://not-secure.example');
    await guide.getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page).getByRole('alert').first()).toContainText('https://');
    await guide.getByPlaceholder('https://….trycloudflare.com').fill('https://quiet-river.trycloudflare.com/');
    await guide.getByRole('button', { name: 'Save' }).click();
    const callback = guide.locator('code', { hasText: '/whatsapp/' });
    await expect(callback).toHaveText(/^https:\/\/quiet-river\.trycloudflare\.com\/whatsapp\/[0-9a-f-]{36}$/);
  });

  test('web chat is one click, and phone access builds a private phone link', async ({ page }) => {
    await captureOutside(page);
    await openBots(page);
    await createBot(page);
    await tab(page, 'Channels').click();
    await dialog(page).getByRole('button', { name: /^Web chat/ }).click();
    await dialog(page).getByRole('button', { name: 'Turn on web chat' }).click();
    const card = dialog(page).locator('.bots-channel');
    await expect(card).toContainText('Ready on this computer');
    await card.getByText('How to use').click();
    await card.getByRole('button', { name: 'Open web chat' }).click();
    await expect.poll(async () => (await opened(page)).at(-1) ?? '').toMatch(/^http:\/\/127\.0\.0\.1:47321\/chat\/[0-9a-f-]{36}#preview-token$/);
    await card.getByRole('checkbox', { name: /Use from my phone/ }).check();
    await expect(card).toContainText('tailscale serve --bg 47321');
    await card.getByPlaceholder('https://your-mac.tailnet.ts.net').fill('https://my-mac.tailnet.ts.net');
    await card.getByRole('button', { name: 'Save' }).click();
    await card.getByRole('button', { name: 'Copy link for my phone' }).click();
    await expect.poll(async () => (await copied(page)).at(-1)).toMatch(/^https:\/\/my-mac\.tailnet\.ts\.net\/chat\/[0-9a-f-]{36}#preview-token$/);
    await card.getByRole('button', { name: 'New link' }).click();
    await dialog(page).getByRole('alertdialog', { name: 'Create a new web chat link?' }).getByRole('button', { name: 'New link' }).click();
    await expect(page.locator('#toast')).toHaveText('New link copied');
    await tab(page, 'Chat').click();
    await expect(dialog(page).getByRole('button', { name: 'Open web chat' })).toBeVisible();
    await expect(dialog(page).locator('.bots-stats')).toContainText('1channel');
  });

  test('rules validate patterns and list allow, ask and deny', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    await tab(page, 'Rules').click();
    await dialog(page).getByRole('textbox', { name: 'Pattern' }).fill('*');
    await dialog(page).getByRole('button', { name: 'Add rule' }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('at least two characters');
    await dialog(page).getByRole('textbox', { name: 'Pattern' }).fill('git push*');
    await dialog(page).getByRole('combobox', { name: 'Decision' }).selectOption('deny');
    await dialog(page).getByRole('button', { name: 'Add rule' }).click();
    await expect(dialog(page).locator('.bots-chip.deny')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Delete rule git push*' }).click();
    await expect(dialog(page).getByText('No rules.', { exact: false })).toBeVisible();
  });

  test('pausing, editing, activity, reset and delete', async ({ page }) => {
    await openBots(page);
    await createBot(page);
    await dialog(page).getByRole('button', { name: 'Pause' }).click();
    await expect(dialog(page).getByText('Paused. Schedules', { exact: false })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Resume' }).click();
    await expect(dialog(page).locator('.bots-banner')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Edit bot' }).click();
    await dialog(page).getByRole('textbox', { name: 'Job' }).fill('Finds answers');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page).locator('.bots-title p')).toHaveText('Finds answers');
    await tab(page, 'Activity').click();
    await expect(dialog(page).locator('.bots-activity')).toContainText('Settings changed');
    await expect(dialog(page).locator('.bots-activity')).toContainText('Created Scout');
    await dialog(page).getByRole('button', { name: 'Reset bot' }).click();
    await expect(dialog(page).getByRole('alertdialog', { name: 'Reset Scout?' })).toBeVisible();
    await dialog(page).getByRole('alertdialog').getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(dialog(page).locator('.bots-activity')).toContainText('Reset');
    await dialog(page).getByRole('button', { name: 'Delete bot' }).click();
    await dialog(page).getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog(page).getByRole('heading', { name: 'New bot' })).toBeVisible();
  });

  test('the sidebar lists bots, opens their page, and keeps their folders out of projects', async ({ page }) => {
    await page.goto('/');
    await expect(sidebar(page).getByRole('button', { name: 'Add a bot' })).toBeVisible();
    await sidebar(page).getByRole('button', { name: 'Add a bot' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'New bot' })).toBeVisible();
    await createBot(page);
    await page.keyboard.press('Escape');
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    const botPage = page.getByRole('region', { name: 'Bot', exact: true });
    await expect(botPage).toBeVisible();
    await expect(page.locator('.conversation-pane')).toBeHidden();
    await expect(botPage.getByRole('heading', { name: 'Scout', level: 3 })).toBeVisible();
    await expect(sidebar(page).locator('.bot-row.selected')).toContainText('Scout');
    await page.getByRole('button', { name: 'Filter projects' }).click();
    await expect(page.locator('.floating-menu')).not.toContainText('Scout');
    await page.keyboard.press('Escape');
    // Another task brings the normal conversation back.
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await expect(botPage).toBeHidden();
    await expect(page.locator('.conversation-pane')).toBeVisible();
  });

  test('a bot page chats in place and keeps its settings beside the chat', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: 'Add a bot' }).click();
    await createBot(page);
    await page.keyboard.press('Escape');
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    const botPage = page.getByRole('region', { name: 'Bot', exact: true });
    const convo = botPage.getByRole('log', { name: 'Conversation with Scout' });
    await expect(convo.getByText('Say hi to Scout')).toBeVisible();
    // The empty conversation offers setup steps; each opens the setting that completes it.
    const setup = convo.getByRole('group', { name: 'Set up Scout' });
    await expect(setup).toContainText('1 of 4 done');
    await setup.getByRole('button', { name: /Schedule recurring work/ }).click();
    await expect(botPage.getByRole('complementary', { name: 'Bot settings' }).getByRole('tab', { name: 'Schedules' })).toHaveAttribute('aria-selected', 'true');
    await expect(botPage.getByRole('textbox', { name: 'What should it do?' })).toBeFocused();
    await setup.getByRole('button', { name: /Tell it what to remember/ }).click();
    // Chat: the reply streams into a bubble on the page itself.
    await botPage.getByRole('textbox', { name: 'Message Scout' }).fill('Remind me what you know');
    await botPage.getByRole('textbox', { name: 'Message Scout' }).press('Enter');
    await expect(convo.locator('.bots-msg.me')).toContainText('Remind me what you know');
    await expect(convo.locator('.bots-msg.bot .bots-msg-body').last()).toContainText('browser preview', { timeout: 15_000 });
    await expect(botPage.getByRole('button', { name: /Open in workspace/ })).toHaveCount(0);
    // Settings: tabs beside the chat; a memory added there shows in the header.
    const settings = botPage.getByRole('complementary', { name: 'Bot settings' });
    await expect(settings.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
    await settings.getByRole('textbox', { name: 'New memory' }).fill('Prefers metric units');
    await settings.getByRole('button', { name: 'Remember' }).click();
    await expect(settings.getByText('Prefers metric units')).toBeVisible();
    await expect(settings.getByRole('tab', { name: 'Memory' })).toHaveText('Memory1');
    await settings.getByRole('tab', { name: 'Activity' }).click();
    await expect(settings.locator('.bots-activity')).toContainText('You (desktop): Remind me what you know');
    // The panel can be put away, and stays away after a reload.
    await botPage.getByRole('button', { name: 'Settings' }).click();
    await expect(settings).toBeHidden();
    await botPage.getByRole('button', { name: 'Settings' }).click();
    await expect(settings).toBeVisible();
    await botPage.getByRole('button', { name: 'Settings' }).click();
    expect(await page.evaluate(() => localStorage.getItem('pandacode.botSettings'))).toBe('closed');
  });

  test('a bot page edits the profile in its panel and leaves when the bot is deleted', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: 'Add a bot' }).click();
    await createBot(page);
    await page.keyboard.press('Escape');
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    const botPage = page.getByRole('region', { name: 'Bot', exact: true });
    await botPage.getByRole('button', { name: 'Edit bot' }).click();
    const settings = botPage.getByRole('complementary', { name: 'Bot settings' });
    await expect(settings.getByText('Profile', { exact: true })).toBeVisible();
    await settings.getByRole('textbox', { name: 'Job' }).fill('Finds answers fast');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(botPage.locator('.bp-meta')).toContainText('Finds answers fast');
    await settings.getByRole('button', { name: 'Back to settings' }).click();
    await expect(settings.getByRole('tab', { name: 'Memory' })).toBeVisible();
    // The composer reads like a task's: its chips show what the bot runs on and open that field.
    const chips = botPage.locator('.bots-chat-tools');
    await expect(chips).toContainText('Ask before acting');
    await chips.getByRole('button', { name: 'Ask before acting' }).click();
    await expect(settings.getByRole('combobox', { name: 'Permissions' })).toBeFocused();
    await settings.getByRole('button', { name: 'Back to settings' }).click();
    await settings.getByRole('button', { name: 'Hide panel' }).click();
    await expect(settings).toBeHidden();
    await botPage.getByRole('button', { name: 'Settings' }).click();
    await expect(settings.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
    await botPage.getByRole('button', { name: 'Pause' }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Chat with Scout (paused)' })).toBeVisible();
    await expect(botPage.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(botPage.locator('.bp-state')).toHaveText('Paused');
    // Destructive actions wait one level down, in More.
    await expect(botPage.getByRole('button', { name: 'Delete bot' })).toHaveCount(0);
    await botPage.getByRole('button', { name: 'More', exact: true }).click();
    await expect(botPage.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(botPage.getByRole('menu')).toHaveCount(0);
    await botPage.getByRole('button', { name: 'More', exact: true }).click();
    await botPage.getByRole('menuitem', { name: 'Delete bot' }).click();
    await botPage.getByRole('alertdialog', { name: 'Delete Scout?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(botPage).toBeHidden();
    await expect(sidebar(page).getByRole('button', { name: 'Add a bot' })).toBeVisible();
  });

  test('bots are reachable from Go to anything', async ({ page }) => {
    await page.goto('/');
    await page.locator('.search-trigger').click();
    await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill('bots');
    await page.locator('#command-results').getByRole('button', { name: 'Bots' }).click();
    await expect(dialog(page)).toBeVisible();
  });
});
