/**
 * 定时提醒 / 定时任务 — qqbot_reminder 工具 + 后台调度器。
 *
 * - 一次性（N 分钟后 / 某个时刻）或重复（每天 / 每周几 / 每 N 分钟）。
 * - 到点时往对应会话（群 / 私聊）注入一轮 [Reminder]，由小喵用人设语气说出提醒，
 *   或执行任务（如「每天 8 点播报天气」）——可以用工具。
 * - 持久化到 ~/.dsh-qqbot/reminders.json，插件重载 / 重启不丢；离线期间错过的
 *   一次性提醒在 6 小时内补发（注明迟到），更早的丢弃；重复任务顺延到下一次。
 * - 权限：任何人可设一次性提醒（每人最多 5 个进行中）；重复任务仅主人。
 *   取消：本人或主人。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { GroupDirectory } from './group-directory.js';
export const REMINDER_TOOL_NAME = 'qqbot_reminder';
const PATH = resolve(homedir(), '.dsh-qqbot', 'reminders.json');
const TICK_MS = 15_000;
const LATE_MAX_MS = 6 * 3_600_000;
const PER_USER_MAX = 5;
const TOTAL_MAX = 200;
const MIN_EVERY_MIN = 10;
const WD = ['日', '一', '二', '三', '四', '五', '六'];
let items = null;
function load() {
    if (items)
        return items;
    items = [];
    try {
        if (existsSync(PATH))
            items = JSON.parse(readFileSync(PATH, 'utf8'))?.items ?? [];
    }
    catch {
        items = [];
    }
    return items;
}
function save() {
    try {
        mkdirSync(dirname(PATH), { recursive: true });
        writeFileSync(PATH, JSON.stringify({ items: load() }, null, 1), 'utf8');
    }
    catch { /* ignore */ }
}
export function listReminders() {
    return load().slice();
}
const pad = (n) => String(n).padStart(2, '0');
export function fmtWhen(ms) {
    const d = new Date(ms);
    const now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diffDay = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0) / 86_400_000);
    if (diffDay === 0)
        return `今天 ${hm}`;
    if (diffDay === 1)
        return `明天 ${hm}`;
    if (diffDay === 2)
        return `后天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
export function fmtRepeat(r) {
    if (!r || r.kind === 'none')
        return '一次性';
    if (r.kind === 'daily')
        return `每天 ${r.time}`;
    if (r.kind === 'weekly')
        return `每周${r.weekdays.map((w) => WD[w]).join('、')} ${r.time}`;
    if (r.kind === 'every')
        return `每 ${r.minutes} 分钟`;
    return '';
}
/** 解析 "HH:mm" / "YYYY-MM-DD HH:mm" / "MM-DD HH:mm" → 下一个匹配时刻（本地时区） */
function parseAt(s, now = Date.now()) {
    const t = String(s ?? '').trim().replace('T', ' ').replace(/[年月\/.]/g, '-').replace(/日/g, ' ').replace(/\s+/g, ' ');
    let m = t.match(/^(\d{1,2})[:：](\d{2})$/);
    if (m) {
        const d = new Date(now);
        d.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (d.getTime() <= now)
            d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    m = t.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2}) ?(\d{1,2})[:：](\d{2})$/);
    if (m) {
        const y = m[1] ? Number(m[1]) : new Date(now).getFullYear();
        const d = new Date(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
        if (!m[1] && d.getTime() <= now)
            d.setFullYear(y + 1);
        return d.getTime();
    }
    return NaN;
}
function nextOf(r, after) {
    if (r.kind === 'every')
        return after + r.minutes * 60_000;
    const [hh, mm] = r.time.split(':').map(Number);
    const d = new Date(after);
    d.setSeconds(0, 0);
    d.setHours(hh, mm);
    for (let i = 0; i < 8; i++) {
        if (d.getTime() > after && (r.kind === 'daily' || r.weekdays.includes(d.getDay())))
            return d.getTime();
        d.setDate(d.getDate() + 1);
        d.setHours(hh, mm, 0, 0);
    }
    return NaN;
}
function normTime(s) {
    const m = String(s ?? '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
        return null;
    return `${pad(Number(m[1]))}:${m[2]}`;
}
const DESCRIPTION = 'Reminders and scheduled tasks in the CURRENT QQ chat (you DO have this ability — never say you cannot set reminders). '
    + 'action=create: set `text` (what to remind / what to do when due, written as an instruction to your future self, e.g. "提醒阿杰去开会" or "播报今天的天气") and ONE timing: '
    + '`after_minutes` (e.g. 5), or `at` local China time ("21:30", "2026-10-22 08:00", "10-22 08:00"), or `repeat` = daily|weekly|every with `time` "HH:mm" (+ `weekdays` 0=Sun..6=Sat for weekly) or `every_minutes` (≥10). '
    + 'Repeating tasks are owner-only; anyone may set one-off reminders (max 5 active each). '
    + 'When due, you get a [Reminder] turn in this chat and should deliver it in character (you may use tools). '
    + 'action=list shows this chat\'s reminders; action=cancel with `id` (creator or owner). Confirm to the user with the exact due time returned.';
export function registerReminderTool(ctx, manager, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_reminder 未注册');
        return;
    }
    tools.register({
        name: REMINDER_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'cancel'] },
                text: { type: 'string', description: 'create: reminder content / task instruction.' },
                after_minutes: { type: 'number', description: 'create: fire after N minutes (0.5–43200).' },
                at: { type: 'string', description: 'create: local time "HH:mm" (next occurrence) or "YYYY-MM-DD HH:mm" / "MM-DD HH:mm".' },
                repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'every'], description: 'create: repetition (owner only unless none).' },
                time: { type: 'string', description: 'daily / weekly: "HH:mm".' },
                weekdays: { type: 'array', items: { type: 'number' }, description: 'weekly: 0=Sun … 6=Sat.' },
                every_minutes: { type: 'number', description: 'every: interval in minutes (≥10).' },
                id: { type: 'string', description: 'cancel: reminder id from list.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
                required: ['ok', 'message'],
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            if (record === undefined)
                return { ok: false, message: 'qqbot_reminder 只能在 QQ 会话中使用' };
            const owner = record.lastSenderOwner === true;
            const all = load();
            const mine = all.filter((r) => r.scope === record.scope && r.peerId === record.peerId);
            const now = Date.now();
            switch (String(args.action)) {
                case 'list': {
                    if (!mine.length)
                        return { ok: true, message: '这个会话没有进行中的提醒 / 定时任务' };
                    return { ok: true, message: mine.sort((a, b) => a.nextAt - b.nextAt).map((r) => `- [${r.id}] ${fmtWhen(r.nextAt)}（${fmtRepeat(r.repeat)}）${r.text} —— ${r.byName || '某人'}设的`).join('\n') };
                }
                case 'cancel': {
                    const id = String(args.id ?? '').trim().toUpperCase();
                    const r = mine.find((x) => x.id === id);
                    if (!r)
                        return { ok: false, message: `本会话没有 id 为 ${id} 的提醒，先 list 看看` };
                    if (!owner && r.by !== record.lastSenderId)
                        return { ok: false, message: '只有设这个提醒的人或主人可以取消' };
                    items = all.filter((x) => x !== r);
                    save();
                    return { ok: true, message: `已取消：${r.text}` };
                }
                case 'create': {
                    const text = String(args.text ?? '').trim().slice(0, 500);
                    if (!text)
                        return { ok: false, message: '缺少 text（要提醒什么 / 到点做什么）' };
                    const kind = args.repeat && args.repeat !== 'none' ? args.repeat : 'none';
                    let repeat = { kind: 'none' };
                    let nextAt;
                    if (kind === 'none') {
                        if (args.after_minutes !== undefined) {
                            const m = Number(args.after_minutes);
                            if (!(m >= 0.5 && m <= 43200))
                                return { ok: false, message: 'after_minutes 需在 0.5–43200 之间' };
                            nextAt = now + Math.round(m * 60_000);
                        }
                        else if (args.at) {
                            nextAt = parseAt(args.at, now);
                            if (!Number.isFinite(nextAt))
                                return { ok: false, message: 'at 格式不对，用 "21:30" 或 "2026-10-22 08:00"' };
                            if (nextAt <= now)
                                return { ok: false, message: '这个时间已经过去了' };
                        }
                        else
                            return { ok: false, message: '给 after_minutes 或 at 指定时间' };
                    }
                    else {
                        if (!owner)
                            return { ok: false, message: '重复的定时任务只有主人能设（一次性提醒谁都可以），请委婉说明' };
                        if (kind === 'every') {
                            const m = Math.round(Number(args.every_minutes));
                            if (!(m >= MIN_EVERY_MIN && m <= 10080))
                                return { ok: false, message: `every_minutes 需在 ${MIN_EVERY_MIN}–10080 之间` };
                            repeat = { kind, minutes: m };
                        }
                        else {
                            const time = normTime(args.time ?? args.at);
                            if (!time)
                                return { ok: false, message: 'daily / weekly 需要 time，如 "08:00"' };
                            if (kind === 'weekly') {
                                const wds = [...new Set((args.weekdays ?? []).map(Number).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))].sort();
                                if (!wds.length)
                                    return { ok: false, message: 'weekly 需要 weekdays（0=周日 … 6=周六）' };
                                repeat = { kind, time, weekdays: wds };
                            }
                            else
                                repeat = { kind: 'daily', time };
                        }
                        nextAt = nextOf(repeat, now);
                    }
                    if (!owner && all.filter((r) => r.by === record.lastSenderId).length >= PER_USER_MAX)
                        return { ok: false, message: `你已经有 ${PER_USER_MAX} 个进行中的提醒了，先取消一些吧` };
                    if (all.length >= TOTAL_MAX)
                        return { ok: false, message: '提醒数量已达上限' };
                    const r = {
                        id: randomBytes(3).toString('hex').toUpperCase(),
                        scope: record.scope, peerId: record.peerId,
                        by: record.lastSenderId ?? '', byName: record.lastSenderName ?? '', byOwner: owner,
                        text, repeat, nextAt, createdAt: now, fired: 0,
                    };
                    all.push(r);
                    items = all;
                    save();
                    logger.info(`im-qqbot: 新提醒 ${r.id} ${record.scope}:${record.peerId.slice(0, 8)} ${fmtWhen(nextAt)} ${fmtRepeat(repeat)} ${text.slice(0, 40)}`);
                    return { ok: true, message: `已设好 [${r.id}]：${fmtWhen(nextAt)}${repeat.kind === 'none' ? '' : `（${fmtRepeat(repeat)}）`} —— ${text}。到点我会在这里说。` };
                }
                default:
                    return { ok: false, message: `未知 action: ${args.action}` };
            }
        },
    });
    logger.info('im-qqbot: qqbot_reminder 工具已注册');
}
/** 后台调度：每 15 秒检查到期项，注入一轮 [Reminder] */
export function startReminderScheduler(manager, logger) {
    const running = new Set();
    const fire = async (r, late) => {
        const target = { scope: r.scope, targetId: r.peerId, msgId: undefined };
        const record = await manager.getOrCreate(r.scope, r.peerId, r.by || r.peerId, target);
        for (let i = 0; i < 40 && record.busy; i++)
            await new Promise((ok) => setTimeout(ok, 3000));
        record.busy = true;
        record.lastSenderOwner = r.byOwner === true;
        record.lastSenderId = r.by;
        record.lastSenderName = r.byName;
        const who = r.byName ? `「${r.byName}」` : '有人';
        const where = r.scope === 'group' ? `群 ${GroupDirectory.label(r.peerId)}` : '私聊';
        const body = [
            `[Reminder] 定时提醒 / 定时任务到点了（${where}，现在 ${fmtWhen(Date.now())}${late ? `，因离线迟到了 ${Math.round(late / 60_000)} 分钟` : ''}）。`,
            `${who}在 ${fmtWhen(r.createdAt)} 设置（${fmtRepeat(r.repeat)}）：${r.text}`,
            r.scope === 'group' && r.byName ? `现在用人设语气在群里提醒 TA（开头叫一下「${r.byName}」），简短自然；如果内容是一项任务就直接去做并给出结果。` : '现在用人设语气提醒对方，简短自然；如果内容是一项任务就直接去做并给出结果。',
            '不要说「这是定时提醒」「系统通知」之类的话，也不要输出 [NO_REPLY]。',
        ].join('\n');
        try {
            record.agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }));
            await record.agent.whenIdle();
        }
        finally {
            record.busy = false;
        }
    };
    const tick = () => {
        const now = Date.now();
        const all = load();
        let changed = false;
        for (const r of [...all]) {
            if (r.nextAt > now || running.has(r.id))
                continue;
            const late = now - r.nextAt;
            const stale = late > LATE_MAX_MS;
            if (r.repeat?.kind && r.repeat.kind !== 'none') {
                r.nextAt = nextOf(r.repeat, now);
                if (!Number.isFinite(r.nextAt))
                    items = load().filter((x) => x !== r);
            }
            else
                items = load().filter((x) => x !== r);
            changed = true;
            if (stale) {
                logger.info(`im-qqbot: 提醒 ${r.id} 已过期 ${Math.round(late / 60_000)} 分钟，跳过`);
                continue;
            }
            r.fired = (r.fired ?? 0) + 1;
            running.add(r.id);
            logger.info(`im-qqbot: 提醒 ${r.id} 到点 → ${r.scope}:${r.peerId.slice(0, 8)}`);
            void fire(r, late > 120_000 ? late : 0)
                .catch((err) => logger.warn(`im-qqbot: 提醒 ${r.id} 执行失败: ${err instanceof Error ? err.message : String(err)}`))
                .finally(() => running.delete(r.id));
        }
        if (changed)
            save();
    };
    const timer = setInterval(() => {
        try {
            tick();
        }
        catch (err) {
            logger.warn(`im-qqbot: 提醒调度异常: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, TICK_MS);
    timer.unref?.();
    setTimeout(() => { try { tick(); } catch { /* ignore */ } }, 5000).unref?.();
    return () => clearInterval(timer);
}
//# sourceMappingURL=reminder.js.map
