/**
 * 每群回复额度（控制 token 用量）
 *
 * 三档：每分钟（滑动 60 秒）、每小时（滑动 60 分钟）、每天（自然日，0 点重置）。
 * 默认 10 / 100 / 200，各群可在群目录覆盖（rateLimit / rateHour / rateDay，0 = 不限）。
 *
 * - 中间件放在 mentionGate / sleepGate 之后：到这里的都是「本来要回复」的群消息。
 *   额度够 → 计一次回复并放行；超额 → 不进 LLM，回一句带剩余 CD 的提示
 *   （同一档位在冷却结束前只提示一次，避免刷屏），其余超额消息静默丢弃（照常落库）。
 * - 水群主动插话也计入额度；额度用完时不主动插话。
 * - 主人不受限（但计数，面板里能看到真实用量）。
 * - 计数持久化到 ~/.dsh-qqbot/rate-counters.json，插件重载不清零。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { GroupDirectory } from './group-directory.js';
const MIN = 60_000;
const HOUR = 3_600_000;
const PATH = resolve(homedir(), '.dsh-qqbot', 'rate-counters.json');
export const RATE_DEFAULTS = { minute: 10, hour: 100, day: 200 };
const OVERRIDE_KEY = { minute: 'rateLimit', hour: 'rateHour', day: 'rateDay' };
const CONFIG_KEY = { minute: 'perMinute', hour: 'perHour', day: 'perDay' };
const LEVEL_TEXT = { minute: '每分钟', hour: '每小时', day: '今天' };
export const DEFAULT_RATE_REPLIES = [
    '说得我口干舌燥了喵…让小喵喝口水，{cd}后再聊嘛 (｡•́︿•̀｡)',
    '呜…大家问得太快啦，小喵的爪爪打字打不过来了，{cd}后再来找我喵～',
    '脑袋要冒烟了喵 (×﹏×) 冷却中，还剩{cd}，一会儿接着聊！',
];
export const DEFAULT_LONG_REPLIES = {
    hour: '小喵这个小时已经回了 {used} 条啦，嗓子要哑了喵～进入 CD，还剩{cd}，稍后再问我吧 (=´ω`=)',
    day: '今天小喵已经回了 {used} 条，额度用光光了喵 (｡-ω-)zzz 还剩{cd}重置（明天 0 点），明天再来找我玩吧～',
};
// ── 计数状态 ──
let state = null; // { groups: { gid: { ts: number[] (近 1 小时), day, dayCount, limited: {day, today, total, last} } } }
let saveTimer = null;
const today = () => new Date().toLocaleDateString('sv-SE');
function load() {
    if (state)
        return state;
    state = { groups: {} };
    try {
        if (existsSync(PATH))
            state = JSON.parse(readFileSync(PATH, 'utf8')) ?? { groups: {} };
        state.groups ??= {};
    }
    catch {
        state = { groups: {} };
    }
    return state;
}
function save() {
    if (saveTimer)
        return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            mkdirSync(dirname(PATH), { recursive: true });
            writeFileSync(PATH, JSON.stringify(load()), 'utf8');
        }
        catch { /* ignore */ }
    }, 1500);
    saveTimer.unref?.();
}
function entry(gid, now = Date.now()) {
    const s = load();
    const d = today();
    const g = (s.groups[gid] ??= { ts: [], day: d, dayCount: 0, limited: { day: d, today: 0, total: 0, last: 0 } });
    g.ts = (g.ts ?? []).filter((t) => now - t < HOUR);
    if (g.day !== d) {
        g.day = d;
        g.dayCount = 0;
    }
    g.limited ??= { day: d, today: 0, total: 0, last: 0 };
    if (g.limited.day !== d) {
        g.limited.day = d;
        g.limited.today = 0;
    }
    return g;
}
/** 本群三档上限（0 = 不限）及是否为本群自定义 */
export function effectiveLimits(gid, config) {
    const dir = (gid ? GroupDirectory.get(gid) : null) ?? {};
    const out = { custom: {} };
    for (const k of ['minute', 'hour', 'day']) {
        const own = dir[OVERRIDE_KEY[k]];
        if (typeof own === 'number') {
            out[k] = own;
            out.custom[k] = true;
            continue;
        }
        const raw = config?.groupRateLimit?.[CONFIG_KEY[k]];
        const d = Number(raw);
        out[k] = raw !== undefined && raw !== null && Number.isFinite(d) && d >= 0 ? Math.floor(d) : RATE_DEFAULTS[k];
        out.custom[k] = false;
    }
    return out;
}
/** 兼容旧接口：每分钟上限 */
export function effectiveLimit(gid, config) {
    return effectiveLimits(gid, config).minute;
}
function usage(g, now) {
    return {
        minute: g.ts.filter((t) => now - t < MIN).length,
        hour: g.ts.length,
        day: g.dayCount,
    };
}
function msUntilMidnight(now) {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime() - now;
}
/** 若已超额返回 { level, waitMs, used, limit }，否则 null（日 > 时 > 分，取最长 CD） */
function overQuota(gid, config, now = Date.now()) {
    const g = entry(gid, now);
    const lim = effectiveLimits(gid, config);
    const u = usage(g, now);
    if (lim.day > 0 && u.day >= lim.day)
        return { level: 'day', waitMs: msUntilMidnight(now), used: u.day, limit: lim.day };
    if (lim.hour > 0 && u.hour >= lim.hour) {
        const sorted = [...g.ts].sort((a, b) => a - b);
        const oldest = sorted[u.hour - lim.hour] ?? sorted[0];
        return { level: 'hour', waitMs: Math.max(1000, oldest + HOUR - now), used: u.hour, limit: lim.hour };
    }
    if (lim.minute > 0 && u.minute >= lim.minute) {
        const inMin = g.ts.filter((t) => now - t < MIN).sort((a, b) => a - b);
        const oldest = inMin[u.minute - lim.minute] ?? inMin[0];
        return { level: 'minute', waitMs: Math.max(1000, oldest + MIN - now), used: u.minute, limit: lim.minute };
    }
    return null;
}
export function fmtWait(ms) {
    const s = Math.ceil(ms / 1000);
    if (s < 60)
        return ` ${s} 秒`;
    const m = Math.ceil(s / 60);
    if (m < 60)
        return ` ${m} 分钟`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return ` ${h} 小时${r ? ` ${r} 分钟` : ''}`;
}
/** 计一次回复（中间件放行 / 水群主动插话时调用） */
export function recordReply(gid, now = Date.now()) {
    try {
        const g = entry(gid, now);
        g.ts.push(now);
        g.dayCount += 1;
        save();
    }
    catch { /* ignore */ }
}
/** 水群用：额度是否已满（满了返回原因文字） */
export function quotaBlocked(gid, config) {
    try {
        const o = overQuota(gid, config);
        return o ? `${LEVEL_TEXT[o.level]}回复额度已满（${o.used}/${o.limit}），CD${fmtWait(o.waitMs)}` : null;
    }
    catch {
        return null;
    }
}
/** 面板 / 工具用：本群额度与用量 */
export function rateStatus(gid, config) {
    const now = Date.now();
    const lim = effectiveLimits(gid, config);
    const g = gid ? entry(gid, now) : { ts: [], dayCount: 0, limited: { today: 0, total: 0, last: 0 } };
    const u = usage(g, now);
    const o = gid ? overQuota(gid, config, now) : null;
    return {
        limit: lim.minute, // 兼容
        custom: lim.custom.minute,
        limits: { minute: lim.minute, hour: lim.hour, day: lim.day },
        customs: lim.custom,
        used: u,
        lastMinute: u.minute, // 兼容
        cooldown: o ? { level: o.level, until: now + o.waitMs, used: o.used, limit: o.limit } : null,
        limitedToday: g.limited?.today ?? 0,
        limitedTotal: g.limited?.total ?? 0,
        lastLimitedAt: g.limited?.last || null,
    };
}
function pickReply(o, config) {
    const cd = fmtWait(o.waitMs);
    let tpl;
    if (o.level === 'minute') {
        const pool = (config.groupRateLimit?.replies ?? []).filter((s) => typeof s === 'string' && s.trim());
        const lines = pool.length ? pool : DEFAULT_RATE_REPLIES;
        tpl = lines[Math.floor(Math.random() * lines.length)];
    }
    else {
        const custom = config.groupRateLimit?.[o.level === 'hour' ? 'hourReply' : 'dayReply'];
        tpl = typeof custom === 'string' && custom.trim() ? custom : DEFAULT_LONG_REPLIES[o.level];
    }
    const text = tpl.replace(/\{cd\}/g, cd).replace(/\{used\}/g, String(o.used)).replace(/\{limit\}/g, String(o.limit));
    return tpl.includes('{cd}') ? text : `${text}（CD 还剩${cd}）`;
}
const notifiedUntil = new Map(); // `${gid}:${level}` → 不再提示直到
export function groupRateLimiter(config, bot, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        if (msg.kind !== 'group' || !msg.groupOpenid) {
            await next();
            return;
        }
        const gid = msg.groupOpenid;
        let blocked = false;
        try {
            const now = Date.now();
            const o = ctx.state.owner === true ? null : overQuota(gid, config, now);
            if (o) {
                blocked = true;
                const g = entry(gid, now);
                g.limited.today += 1;
                g.limited.total += 1;
                g.limited.last = now;
                save();
                const key = `${gid}:${o.level}`;
                if ((notifiedUntil.get(key) ?? 0) <= now) {
                    // 分钟档最多每 60 秒提示一次；小时/天档在 CD 结束前只提示一次
                    notifiedUntil.set(key, now + (o.level === 'minute' ? Math.max(o.waitMs, MIN) : o.waitMs));
                    const text = pickReply(o, config);
                    logger.info(`im-qqbot: 群 ${gid.slice(0, 8)} ${LEVEL_TEXT[o.level]}回复额度已满 ${o.used}/${o.limit}，CD${fmtWait(o.waitMs)}`);
                    try {
                        await bot.sendMarkdown({ scope: 'group', targetId: gid, msgId: msg.messageId }, text);
                    }
                    catch (err) {
                        logger.warn(`im-qqbot: 限频提示发送失败: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
            else {
                recordReply(gid, now);
            }
        }
        catch (err) {
            logger.warn(`im-qqbot: 群限频异常（放行）: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (blocked) {
            ctx.stop('group-rate-limit');
            return;
        }
        await next();
    };
}
//# sourceMappingURL=group-rate-limit.js.map
