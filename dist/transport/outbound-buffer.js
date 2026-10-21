import { chunkMarkdownText } from "./chunker.js";
import { StreamingWriter } from "./streaming-writer.js";
import { NO_REPLY_TOKEN } from "../features/group-engage.js";
import { getActivePulse } from "../features/group-pulse.js";
/** 去掉静默标记；整条只有标记时返回空串 */
export function stripNoReply(text) {
    return text.includes(NO_REPLY_TOKEN) ? text.split(NO_REPLY_TOKEN).join('').trim() : text;
}
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
export class OutboundBuffer {
    buffer = '';
    flushing = false;
    writer;
    record;
    bot;
    limit;
    logger;
    constructor(record, bot, limit, logger, streamingEnabled) {
        this.record = record;
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.writer = streamingEnabled
            ? new StreamingWriter({ bot, target: record.replyTarget, logger, throttleMs: STREAM_THROTTLE_MS })
            : null;
    }
    /** 追加文本增量 */
    append(text) {
        this.buffer += text;
        this.writer?.append(text);
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            if (this.writer) {
                await this.writer.finish();
                // 流式成功（未降级）→ 直接返回
                if (!this.writer.shouldFallback)
                    return;
            }
            // 降级：静态发送（writer 不存在 or 流式失败）
            // 群聊主动参与：agent 输出 [NO_REPLY] 表示保持沉默
            const text = stripNoReply(this.buffer);
            if (!text.trim()) {
                this.logger.info('im-qqbot: agent 选择不回复（NO_REPLY）');
                return;
            }
            if (this.record.scope === 'group') {
                try {
                    getActivePulse()?.onBotSent(this.record.peerId, text);
                }
                catch { /* ignore */ }
            }
            const chunks = chunkMarkdownText(text, this.limit);
            for (const chunk of chunks) {
                await this.bot.sendMarkdown(this.record.replyTarget, chunk);
            }
        }
        catch (err) {
            this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map