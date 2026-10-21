/**
 * 出站回复目标解析与发送 — 被动回复三级兜底 + msg_id/event_id 区分。
 *
 * 从 gateway 层抽离，保持 bootstrap 只做组装。三级兜底：
 *   1. 优先显式 target.msgId；
 *   2. 超频/过期后，用缓存里「最近一条未超频未过期」的 target；
 *   3. 全部候选都超频/过期，才降级为主动推送（proactive）。
 */
import { MsgType } from '@tencent-connect/qqbot-nodejs';
import { getCachedReplyIds } from "./msgid-cache.js";
import { opsLog } from "../shared/ops-log.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));
/**
 * 带重试的发送：被动回复（带 msg_id / event_id）最多试 3 次（间隔 0.8s / 2s），
 * 仍失败则降级为主动消息（去掉 msg_id / event_id）再试 2 次。每次尝试都写操作日志。
 * send(t) 用解析好的目标真正发出去；最终失败时抛出最后一个错误。
 */
export async function sendWithRetry(kind, target, send, preview = '') {
    const passive = Boolean(target.msgId || target.eventId);
    const plans = passive
        ? [target, target, target, { ...target, msgId: undefined, eventId: undefined }, { ...target, msgId: undefined, eventId: undefined }]
        : [target, target, target];
    const waits = [0, 800, 2000, 300, 1500];
    let last;
    for (let i = 0; i < plans.length; i++) {
        const t = plans[i];
        const mode = t.msgId || t.eventId ? 'passive' : 'proactive';
        if (waits[i])
            await sleep(waits[i]);
        try {
            const res = await send(t);
            opsLog('send', { type: kind, ok: true, mode, attempt: i + 1, scope: t.scope, to: t.targetId, msgId: t.msgId ?? t.eventId, preview });
            return res;
        }
        catch (err) {
            last = err;
            opsLog('send', { type: kind, ok: false, mode, attempt: i + 1, scope: t.scope, to: t.targetId, msgId: t.msgId ?? t.eventId, error: errText(err), preview });
        }
    }
    opsLog('send', { type: kind, ok: false, final: true, scope: target.scope, to: target.targetId, error: errText(last), preview });
    throw last;
}
/**
 * 解析被动回复目标。
 *
 * @param allowEvent 是否允许返回互动事件 eventId。markdown 发送支持 event_id
 *   （bot.send 的 extra），传 true；文件发送 SDK 暂不支持 event_id，传 false
 *   跳过 event 候选，降级为 msg 候选或主动推送。
 */
export function resolveReplyTarget(target, limiter, allowEvent) {
    const candidates = [];
    if (target.msgId)
        candidates.push({ kind: 'msg', id: target.msgId });
    for (const c of getCachedReplyIds(target.scope, target.targetId)) {
        candidates.push(c);
    }
    for (const c of candidates) {
        if (c.kind === 'event' && !allowEvent)
            continue;
        if (limiter.checkLimit(c.id).allowed) {
            limiter.record(c.id);
            if (c.kind === 'event') {
                return { ...target, msgId: undefined, eventId: c.id };
            }
            return { ...target, msgId: c.id, eventId: undefined };
        }
    }
    return { ...target, msgId: undefined, eventId: undefined };
}
/**
 * 发送 markdown：区分 msg_id 与 event_id。
 * 带 eventId 时通过 bot.send 的 extra 填 event_id（SDK sendMarkdown 不支持）；
 * 否则走 sendMarkdown 填 msg_id。
 */
export function sendResolvedMarkdown(bot, target, content, opts) {
    if (target.eventId) {
        return bot.send({
            target: { scope: target.scope, targetId: target.targetId, msgId: undefined },
            msgType: MsgType.MARKDOWN,
            markdown: { content },
            keyboard: opts?.keyboard,
            extra: { event_id: target.eventId },
        });
    }
    return bot.sendMarkdown(target, content, opts);
}
//# sourceMappingURL=reply-target.js.map