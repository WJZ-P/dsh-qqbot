import { chunkMarkdownText } from "./chunker.js";
import { opsLog } from "../shared/ops-log.js";
import { finishTurn } from "../features/auto-sticker.js";
import { OutboundBuffer, sendPieces, stripNoReply, unsplit } from "./outbound-buffer.js";
import { formatToolResult } from "./tool-presenter.js";
import { parseEvent, extractTurnError, } from "./events.js";
import { getActivePulse } from "../features/group-pulse.js";
/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/** 属于「这个模型现在用不了」的失败（限流、地区、下线、鉴权、上游 5xx 等），用户取消不算 */
const MODEL_FAILURE_RE = /RATE|LIMIT|429|QUOTA|REGION|UNAVAILABLE|NOT_FOUND|404|MODEL|AUTH|401|403|OVERLOAD|5\d\d|SERVER|TRANSPORT|TIMEOUT|STREAM_CUT|unavailable|not available|rate limit|not found|does not exist/i;
/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
    buffers = new Map();
    toolCalls = new Map();
    manager;
    bot;
    config;
    logger;
    toolsRegistry;
    constructor(manager, bot, config, logger, toolsRegistry) {
        this.manager = manager;
        this.bot = bot;
        this.config = config;
        this.logger = logger;
        this.toolsRegistry = toolsRegistry;
    }
    /** 事件分发入口 */
    route(session, raw) {
        const event = parseEvent(raw);
        if (event === undefined)
            return;
        const record = this.manager.findBySessionId(session.header.id);
        if (record === undefined)
            return;
        switch (event.type) {
            case 'assistant/chunk':
                this.onChunk(session.header.id, record, event);
                break;
            case 'assistant/message':
                this.onMessage(session.header.id, record, event);
                break;
            case 'tool/call':
                this.onToolCall(event);
                break;
            case 'tool/result':
                this.onToolResult(record, event);
                break;
            case 'turn/end':
                this.onTurnEnd(session.header.id, record, event);
                break;
        }
    }
    /** 流式文本增量：累积到会话 buffer */
    onChunk(sessionId, record, event) {
        let buffer = this.buffers.get(sessionId);
        if (buffer === undefined) {
            buffer = new OutboundBuffer(record, this.bot, this.config.textChunkLimit, this.logger, this.shouldStream(record));
            this.buffers.set(sessionId, buffer);
        }
        buffer.append(event.text);
    }
    /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
    shouldStream(record) {
        return this.config.streaming
            && record.replyTarget.scope === 'c2c'
            && !!record.replyTarget.msgId;
    }
    /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
    onMessage(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        if (buffer !== undefined && buffer.text.trim()) {
            this.track(record, buffer.flush());
            this.buffers.delete(sessionId);
            return;
        }
        const textParts = [];
        for (const block of event.content) {
            if (block.type === 'text' && block.text)
                textParts.push(block.text);
        }
        const fullText = textParts.join('\n');
        if (!fullText.trim())
            return;
        this.track(record, this.send(record, fullText, 'sendMarkdown'));
        this.buffers.delete(sessionId);
    }
    /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
    onToolCall(event) {
        this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
    }
    /** 工具结果：错误始终发送，成功结果按开关 */
    onToolResult(record, event) {
        const call = this.toolCalls.get(event.callId);
        this.toolCalls.delete(event.callId);
        if (call === undefined)
            return;
        opsLog('tool', { name: call.name, session: record.sessionKey, args: (() => { try { return JSON.stringify(call.args); } catch { return ''; } })(), ok: event.error === undefined, error: event.error === undefined ? undefined : String(event.error?.message ?? event.error) });
        if (event.error === undefined && !this.config.showToolResults)
            return;
        const text = formatToolResult(call.name, call.args, event.raw, this.toolsRegistry, record.agent);
        if (!text)
            return;
        void this.send(record, text, 'sendToolResult');
    }
    /** 轮次结束：清理 buffer，异常结束时告知用户 */
    onTurnEnd(sessionId, record, event) {
        const buffer = this.buffers.get(sessionId);
        const hadOutput = Boolean(buffer?.text?.trim()) || Boolean(record.turnOut?.text?.trim());
        if (buffer !== undefined) {
            if (buffer.text.trim()) {
                this.track(record, buffer.flush());
            }
            else {
                buffer.cancel();
            }
            this.buffers.delete(sessionId);
        }
        const failure = extractTurnError(event.reason);
        if (failure !== undefined)
            opsLog('turn-error', { session: record.sessionKey, code: failure.code, error: failure.message });
        let retrying = false;
        if (failure !== undefined && MODEL_FAILURE_RE.test(`${failure.code} ${failure.message}`)) {
            try {
                const r = this.manager.markModelBad(record);
                this.logger.warn(`im-qqbot: 模型调用失败，15 分钟内视为不可用: ${r?.provider}/${r?.model}（${failure.code}）`);
            }
            catch { /* ignore */ }
            // 还没发出任何内容、且本条消息还没重试过：交给 inbound 换同组替补模型重答一次，先不报错
            if (!hadOutput && record.retryArmed === true) {
                record.retryArmed = false;
                record.retryAfterFailure = failure;
                retrying = true;
            }
        }
        if (failure !== undefined && !retrying && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
            void this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
        }
        void finishTurn(record, this.logger);
        this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
    }
    /** 记录本轮出站发送，供回合结束后（如自动配表情包）等待 */
    track(record, promise) {
        record.turnOut?.pending.push(promise);
        return promise;
    }
    /** 统一发送：切分 + 逐 chunk 发送 + 错误记录 */
    async send(record, text, tag) {
        text = stripNoReply(text);
        if (!text.trim()) {
            this.logger.info(`im-qqbot: ${tag} skipped (NO_REPLY)`);
            return;
        }
        if (tag === 'sendMarkdown' && record.turnOut)
            record.turnOut.text += `${text}\n`;
        if (record.scope === 'group' && tag === 'sendMarkdown') {
            try {
                getActivePulse()?.onBotSent(record.peerId, unsplit(text));
            }
            catch { /* ignore */ }
        }
        if (tag !== 'sendMarkdown')
            text = unsplit(text);
        await sendPieces(text, this.config.textChunkLimit, async (chunk) => {
            try {
                await this.bot.sendMarkdown(record.replyTarget, chunk);
            }
            catch (err) {
                this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    }
}
/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示。
 */
export function createOutboundHandler(manager, bot, config, logger, toolsRegistry) {
    const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry);
    return (session, event) => router.route(session, event);
}
//# sourceMappingURL=outbound.js.map