/**
 * 群聊「主动参与」判定 — 未 @ 机器人的群消息何时触发一次回复。
 *
 * 规则（requireMention=false 且 groupEngage.mode='smart' 时生效）：
 *   - @ 机器人：必定回复，并重置该群冷却；
 *   - 未 @：消息需「与机器人相关」（命中关键词；未配置关键词时任何文本消息都算候选），
 *     且距该群上次触发已超过随机冷却 [minIntervalSec, maxIntervalSec]，才触发一次；
 *   - 其余消息只落库 / 进入历史缓冲，不触发回复。
 *
 * 触发后 agent 仍可判断无需发言，输出 NO_REPLY_TOKEN 即静默（出站层拦截）。
 */
/** agent 判定无需回复时输出的静默标记 */
export const NO_REPLY_TOKEN = '[NO_REPLY]';
export const DEFAULT_GROUP_ENGAGE = {
    mode: 'smart',
    minIntervalSec: 60,
    maxIntervalSec: 120,
    keywords: [],
};
/** 规范化配置（容错：非法值回落默认） */
export function normalizeGroupEngage(raw) {
    const cfg = { ...DEFAULT_GROUP_ENGAGE, ...(raw ?? {}) };
    const min = Math.max(0, Number(cfg.minIntervalSec) || 0);
    const max = Math.max(min, Number(cfg.maxIntervalSec) || min);
    const keywords = Array.isArray(cfg.keywords)
        ? cfg.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
        : [];
    return { mode: cfg.mode === 'all' ? 'all' : 'smart', minIntervalSec: min, maxIntervalSec: max, keywords };
}
/** 是否命中「与机器人相关」 */
function isRelevant(msg, engage) {
    const text = (msg.content ?? '').trim().toLowerCase();
    if (engage.keywords.length === 0) {
        // 未配置关键词：有文本或附件即视为候选，由 agent 自行判断是否值得发言
        return text.length > 0 || (Array.isArray(msg.attachments) && msg.attachments.length > 0);
    }
    return engage.keywords.some((k) => text.includes(k));
}
/**
 * 创建判定器：返回 mentionGate 的 isImplicitMention 回调，以及 @ 时的冷却重置。
 * 冷却状态按群保存在内存（进程重启后重新计时，无副作用）。
 */
export function createGroupEngage(rawConfig, logger, isAsleep = () => false) {
    const engage = normalizeGroupEngage(rawConfig);
    /** groupOpenid → 下次允许主动参与的时间戳(ms) */
    const nextAllowedAt = new Map();
    const scheduleNext = (groupId, now) => {
        const span = engage.maxIntervalSec - engage.minIntervalSec;
        const delaySec = engage.minIntervalSec + Math.random() * span;
        nextAllowedAt.set(groupId, now + Math.round(delaySec * 1000));
    };
    const isMentioned = (msg) => msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
        || (Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true));
    /** mentionGate.isImplicitMention 回调 */
    const isImplicitMention = (ctx) => {
        const msg = ctx.message;
        if (msg.kind !== 'group')
            return false;
        const groupId = msg.groupOpenid ?? '';
        const now = Date.now();
        if (isMentioned(msg)) {
            // @ 必回复（由 mentionGate 自身判定），这里只重置冷却，避免紧接着又主动插话
            scheduleNext(groupId, now);
            return false;
        }
        if (msg.author?.bot === true || msg.raw?.author?.bot === true)
            return false;
        if (isAsleep())
            return false; // 睡觉中：不随机挑消息
        if (!isRelevant(msg, engage))
            return false;
        const allowedAt = nextAllowedAt.get(groupId) ?? 0;
        if (now < allowedAt)
            return false;
        scheduleNext(groupId, now);
        ctx.state.engage = { proactive: true };
        logger.info(`im-qqbot: 群主动参与触发 group=${groupId} (下次最早 ${Math.round((nextAllowedAt.get(groupId) - now) / 1000)}s 后)`);
        return true;
    };
    return { engage, isImplicitMention };
}
//# sourceMappingURL=group-engage.js.map
