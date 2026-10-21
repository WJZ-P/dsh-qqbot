/**
 * 批量拉取消息：正在回复某条消息时，同一群 / 私聊新来的消息先排队，
 * 本轮结束后一次性取出（默认最多最近 10 条）合成一轮，让模型一次回复不同的人。
 * 好处：少跑很多轮模型（每轮都要重发整段上下文），也更像真人「一口气回一串」。
 *
 * 作为 SDK concurrencyGuard 的 onMerge：survivor 取最后一条（msg_id 最新，被动回复不过期），
 * 其余消息的摘要放到 survivor.state.batch，由 inbound 组装成一条「多人消息」。
 */
import { unrecordReply } from './group-rate-limit.js';
export const BATCH_MAX_DEFAULT = 10;
function attTag(atts) {
    const n = { image: 0, voice: 0, video: 0, file: 0 };
    for (const a of atts ?? []) {
        const t = String(a.content_type ?? '');
        if (t.startsWith('image/'))
            n.image += 1;
        else if (t.includes('voice') || t.includes('audio') || t.includes('silk') || t.includes('amr'))
            n.voice += 1;
        else if (t.startsWith('video/'))
            n.video += 1;
        else
            n.file += 1;
    }
    return [n.image && `[图片×${n.image}]`, n.voice && '[语音]', n.video && '[视频]', n.file && `[文件×${n.file}]`].filter(Boolean).join('');
}
export function createBatchMerger(getMax, logger) {
    return (buffered) => {
        if (buffered.length <= 1)
            return buffered[0];
        const max = Math.max(1, Math.floor(Number(getMax())) || BATCH_MAX_DEFAULT);
        const kept = buffered.slice(-max);
        const survivor = kept[kept.length - 1];
        const items = kept.map((ctx) => {
            const m = ctx.message;
            const voice = (m.attachments ?? []).map((a) => a.asr_refer_text).filter(Boolean).join(' ');
            return {
                senderId: m.senderId,
                senderName: m.senderName ?? m.raw?.author?.username ?? '',
                text: [String(m.content ?? '').trim(), voice && `[语音转文字] ${voice}`].filter(Boolean).join(' '),
                atts: ctx === survivor ? '' : attTag(m.attachments),
                owner: ctx.state.owner === true,
                mentioned: ctx.state.mention?.wasMentioned === true,
                proactive: ctx.state.engage?.proactive === true,
                self: ctx === survivor,
            };
        });
        survivor.state.batch = { items, dropped: buffered.length - kept.length };
        if (items.some((x) => x.owner))
            survivor.state.batchHasOwner = true;
        // 群额度：排队时每条都计过一次，合并后只算一次回复
        const m0 = survivor.message;
        if (m0.kind === 'group' && m0.groupOpenid) {
            const counted = buffered.filter((c) => c.state.owner !== true).length;
            unrecordReply(m0.groupOpenid, counted - (counted > 0 ? 1 : 0));
        }
        logger?.info?.(`im-qqbot: 批量合并 ${buffered.length} 条消息（取最近 ${kept.length} 条）→ ${m0.kind === 'group' ? m0.groupOpenid?.slice(0, 8) : 'c2c'}`);
        return survivor;
    };
}
//# sourceMappingURL=batch-merge.js.map
