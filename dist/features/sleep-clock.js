/**
 * 睡眠机制 — 夜间（默认 00:00–08:00，宿主本地时区）机器人「睡觉」以节省 token：
 *   - 睡眠期间不做群聊主动参与（不再随机挑消息）；
 *   - 普通用户的 @ / 私聊不触发 LLM，可选回一句固定的「睡觉中」提示（按会话节流）；
 *   - 主人 @（群）或私聊 → 起床 wakeMinutes 分钟（期间行为与白天一致），到点自动回去睡；
 *     起床期间主人再次互动会顺延。
 * 所有消息照常落库。
 */
export const DEFAULT_SLEEP = {
    enabled: true,
    start: '00:00',
    end: '08:00',
    wakeMinutes: 30,
    ownerIds: [],
    sleepReply: '呼…小喵在睡觉喵 zzZ，明早 8 点再来找我吧～',
    sleepReplyCooldownMin: 30,
};
/** 当前网关的时钟（面板状态路由读取；网关重启时替换） */
let activeClock = null;
export function getActiveSleepClock() {
    return activeClock;
}
function parseHm(text, fallback) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (!m)
        return fallback;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 24 || min > 59)
        return fallback;
    return (h * 60 + min) % 1440;
}
export function normalizeSleep(raw) {
    const cfg = { ...DEFAULT_SLEEP, ...(raw ?? {}) };
    return {
        enabled: cfg.enabled !== false,
        startMin: parseHm(cfg.start, 0),
        endMin: parseHm(cfg.end, 480),
        start: String(cfg.start),
        end: String(cfg.end),
        wakeMinutes: Math.max(1, Math.min(720, Number(cfg.wakeMinutes) || 30)),
        ownerIds: Array.isArray(cfg.ownerIds) ? cfg.ownerIds.map((s) => String(s).trim()).filter(Boolean) : [],
        sleepReply: typeof cfg.sleepReply === 'string' ? cfg.sleepReply : '',
        sleepReplyCooldownMin: Math.max(0, Number(cfg.sleepReplyCooldownMin) || 0),
    };
}
export class SleepClock {
    cfg;
    logger;
    wakeUntil = 0;
    /** 会话 key → 上次发送睡眠提示时间 */
    lastSleepReply = new Map();
    constructor(raw, logger) {
        this.cfg = normalizeSleep(raw);
        this.logger = logger;
        activeClock = this;
    }
    dispose() {
        if (activeClock === this)
            activeClock = null;
    }
    /** 当前本地时间是否落在睡眠时段（支持跨零点） */
    inWindow(now = Date.now()) {
        if (!this.cfg.enabled)
            return false;
        const d = new Date(now);
        const minute = d.getHours() * 60 + d.getMinutes();
        const { startMin, endMin } = this.cfg;
        if (startMin === endMin)
            return false;
        return startMin < endMin
            ? minute >= startMin && minute < endMin
            : minute >= startMin || minute < endMin;
    }
    isAwakeByOwner(now = Date.now()) {
        return now < this.wakeUntil;
    }
    isAsleep(now = Date.now()) {
        return this.inWindow(now) && !this.isAwakeByOwner(now);
    }
    isOwner(senderId) {
        return typeof senderId === 'string' && this.cfg.ownerIds.includes(senderId);
    }
    wake(now = Date.now()) {
        const wasAsleep = this.isAsleep(now);
        this.wakeUntil = now + this.cfg.wakeMinutes * 60_000;
        this.logger.info(`im-qqbot: 主人唤醒，清醒至 ${new Date(this.wakeUntil).toLocaleTimeString()}`);
        return wasAsleep;
    }
    /** 是否应发送睡眠提示（按会话节流） */
    takeSleepReply(key, now = Date.now()) {
        if (!this.cfg.sleepReply.trim())
            return false;
        const last = this.lastSleepReply.get(key) ?? 0;
        if (now - last < this.cfg.sleepReplyCooldownMin * 60_000)
            return false;
        this.lastSleepReply.set(key, now);
        return true;
    }
    status(now = Date.now()) {
        return {
            enabled: this.cfg.enabled,
            start: this.cfg.start,
            end: this.cfg.end,
            inWindow: this.inWindow(now),
            asleep: this.isAsleep(now),
            wakeUntil: this.isAwakeByOwner(now) ? this.wakeUntil : null,
            ownerCount: this.cfg.ownerIds.length,
        };
    }
}
/**
 * 睡眠门控中间件：放在 mentionGate 之后（此时只剩「本应回复」的消息）。
 */
export function sleepGate(clock, bot, logger) {
    return async (ctx, next) => {
        const now = Date.now();
        const msg = ctx.message;
        const isGroup = msg.kind === 'group';
        // 主人身份（按 openid 识别），供 envelope 标注 [主人]
        ctx.state.owner = clock.isOwner(msg.senderId);
        if (!clock.inWindow(now)) {
            await next();
            return;
        }
        const mentioned = ctx.state.mention?.wasMentioned === true;
        // 群里需要 @ 才算「主人叫醒」；私聊主人发任何消息都算
        if (clock.isOwner(msg.senderId) && (!isGroup || mentioned)) {
            const wokeUp = clock.wake(now);
            if (wokeUp)
                ctx.state.sleep = { wokenByOwner: true, wakeMinutes: clock.cfg.wakeMinutes };
            await next();
            return;
        }
        if (clock.isAwakeByOwner(now)) {
            await next();
            return;
        }
        // 睡着：主动参与触发的直接丢弃；@ / 私聊可回一句固定提示（不消耗 token）
        if (!isGroup || mentioned) {
            const key = `${msg.kind}:${isGroup ? msg.groupOpenid : msg.senderId}`;
            if (clock.takeSleepReply(key, now)) {
                try {
                    const target = {
                        scope: isGroup ? 'group' : 'c2c',
                        targetId: isGroup ? (msg.groupOpenid ?? msg.senderId) : msg.senderId,
                        msgId: msg.messageId,
                    };
                    await bot.sendMarkdown(target, clock.cfg.sleepReply);
                }
                catch (err) {
                    logger.warn(`im-qqbot: 睡眠提示发送失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        ctx.stop('sleep');
    };
}
//# sourceMappingURL=sleep-clock.js.map
