/**
 * 群历史附件补全 — SDK historyBuffer 只记录 msg.content（纯文本），
 * 纯图片 / 文件 / 语音消息在历史里变成空行，后续 @ 时 AI 不知道之前发了什么。
 *
 * 放在 historyBuffer 之后：找到刚写入的那条历史，把附件描述补进 content；
 * 未 @ 的消息不会经过 attachmentProcessor，这里异步下载图片/文件到本地，
 * 完成后把 content 中的 URL 替换为本地路径（下次 @ 组包时 AI 可直接 read 查看）。
 * 被 @ 的消息由正常链路处理，这里只补描述、不重复下载。
 */
import { classifyContentType, downloadMediaAttachments } from "../transport/attachment.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
const LABEL = { image: '图片', video: '视频', file: '文件' };
function isAtBot(msg) {
    const raw = msg.raw;
    if (raw?.eventType === 'GROUP_AT_MESSAGE_CREATE' || msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE')
        return true;
    const mentions = raw?.mentions ?? raw?.d?.mentions ?? msg.mentions;
    return Array.isArray(mentions) && mentions.some((m) => m?.is_you === true);
}
function describe(attachments, downloaded) {
    const byName = new Map((downloaded ?? []).map((d) => [d.filename, d]));
    const parts = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice') {
            parts.push(att.asr_refer_text ? `[语音] ${att.asr_refer_text}` : '[语音]');
            continue;
        }
        const d = byName.get(att.filename);
        const where = d?.localPath ?? att.url ?? att.filename ?? '';
        parts.push(`[${LABEL[kind] ?? '附件'}: ${where}]`);
    }
    return parts.join(' ');
}
export function historyAttachments(config, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        const gid = msg.groupOpenid;
        const attachments = msg.attachments ?? [];
        if (msg.kind !== 'group' || !gid || attachments.length === 0) {
            await next();
            return;
        }
        try {
            const key = historyGroupKey(config.appId, gid);
            const entry = (await getHistoryStore().list(key, 500)).find((e) => e.messageId === msg.messageId);
            if (entry !== undefined) {
                const text = (entry.content ?? '').trim();
                const join = (desc) => (text ? `${text} ${desc}` : desc);
                entry.content = join(describe(attachments));
                const wantDownload = !isAtBot(msg) && attachments.some((a) => classifyContentType(a.content_type) !== 'voice');
                if (wantDownload) {
                    void downloadMediaAttachments(attachments, config.media, logger)
                        .then((downloaded) => {
                        if (downloaded.length > 0)
                            entry.content = join(describe(attachments, downloaded));
                    })
                        .catch((err) => logger.warn(`im-qqbot: 历史附件下载失败: ${err instanceof Error ? err.message : String(err)}`));
                }
            }
        }
        catch (err) {
            logger.warn(`im-qqbot: 历史附件补全失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        await next();
    };
}
//# sourceMappingURL=history-attachments.js.map
