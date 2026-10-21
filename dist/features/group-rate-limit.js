/**
 * 每群每分钟回复限频
 *
 * 放在 mentionGate / sleepGate 之后：到这里的都是「本来要回复」的群消息。
 * 60 秒滑动窗口内超过上限 → 不进 LLM，回一句固定的可爱话（同一群一个窗口内只回一次，避免刷屏），
 * 其余超额消息静默丢弃（消息本身已被 messageRecorder 落库，不影响记录）。
 * 主人不受限。上限：群目录 rateLimit（0 = 不限）> 全局 config.groupRateLimit.perMinute。
 */
import { GroupDirectory } from './group-directory.js';
const WINDOW_MS = 60_000;
export const DEFAULT_RATE_REPLIES = [
    '说得我口干舌燥了喵…让小喵喝口水，等一下下再聊嘛 (｡•́︿•̀｡)',
    '呜…大家问得太快啦，小喵的爪爪打字打不过来了喵，歇一分钟再来～',
    '脑袋要冒烟了喵 (×﹏×) 让我缓一缓，一会儿接着聊！',
    '喵呜——今天的嘴巴营业额超标了，小喵先去舔舔毛，马上回来～',
];
const windows = new Map(); // gid → number[]（时间戳）
const notified = new Map(); // gid → 上次发可爱提示的时间
const hits = new Map(); // gid → { total, today, day, last }
const today = () => new Date().toLocaleDateString('sv-SE');
/** 本群生效的每分钟上限；0 = 不限 */
export function effectiveLimit(gid, config) {
    const own = GroupDirectory.get(gid)?.rateLimit;
    if (typeof own === 'number')
        return own;
    const d = Number(config?.groupRateLimit?.perMinute);
    return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 15;
}
function recordHit(gid, now) {
    const d = today();
    const h = hits.get(gid) ?? { total: 0, today: 0, day: d, last: 0 };
    if (h.day !== d) {
        h.day = d;
        h.today = 0;
    }
    h.total += 1;
    h.today += 1;
    h.last = now;
    hits.set(gid, h);
}
/** 面板用：本群近 60 秒已回复次数、被限次数 */
export function rateStatus(gid, config) {
    const now = Date.now();
    const w = (windows.get(gid) ?? []).filter((t) => now - t < WINDOW_MS);
    const h = hits.get(gid);
    return {
        limit: effectiveLimit(gid, config),
        custom: typeof GroupDirectory.get(gid)?.rateLimit === 'number',
        lastMinute: w.length,
        limitedToday: h && h.day === today() ? h.today : 0,
        limitedTotal: h?.total ?? 0,
        lastLimitedAt: h?.last || null,
    };
}
export function groupRateLimiter(config, bot, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        if (msg.kind !== 'group' || !msg.groupOpenid || ctx.state.owner === true) {
            await next();
            return;
        }
        let blocked = false;
        try {
            const gid = msg.groupOpenid;
            const limit = effectiveLimit(gid, config);
            if (limit > 0) {
                const now = Date.now();
                const w = (windows.get(gid) ?? []).filter((t) => now - t < WINDOW_MS);
                if (w.length >= limit) {
                    blocked = true;
                    windows.set(gid, w);
                    recordHit(gid, now);
                    const last = notified.get(gid) ?? 0;
                    if (now - last >= WINDOW_MS) {
                        notified.set(gid, now);
                        const pool = (config.groupRateLimit?.replies ?? []).filter((s) => typeof s === 'string' && s.trim());
                        const lines = pool.length ? pool : DEFAULT_RATE_REPLIES;
                        const text = lines[Math.floor(Math.random() * lines.length)];
                        logger.info(`im-qqbot: 群 ${gid.slice(0, 8)} 超过每分钟 ${limit} 次回复，发送限频提示`);
                        try {
                            await bot.sendMarkdown({ scope: 'group', targetId: gid, msgId: msg.messageId }, text);
                        }
                        catch (err) {
                            logger.warn(`im-qqbot: 限频提示发送失败: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                }
                else {
                    w.push(now);
                    windows.set(gid, w);
                }
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
