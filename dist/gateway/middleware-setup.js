import { errorHandler, messageFilter, accessPolicy, mentionGate, contentSanitizer, rateLimiter, slashCommand, concurrencyGuard, typingIndicator, quoteRef, historyBuffer, envelopeFormatter, } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from "../commands/index.js";
import { attachmentProcessor } from "../middleware/attachment.js";
import { questionAnswer } from "../middleware/question-answer.js";
import { historyAttachments } from "../middleware/history-attachments.js";
import { getHistoryStore, historyGroupKey } from "../features/history-store.js";
import { messageRecorder } from "../features/message-store.js";
import { createGroupEngage } from "../features/group-engage.js";
import { SleepClock, sleepGate } from "../features/sleep-clock.js";
export function setupMiddlewares(bot, config, manager, logger, messageStore = null, pulse = null) {
    // 1. 错误兜底（最外层洋葱皮）
    bot.use(errorHandler());
    // 2. 消息过滤：bot 回声 + 消息去重
    bot.use(messageFilter({ skipSelfEcho: false }));
    // 2.5. 消息落库（SQLite）— 去重之后、访问控制/门控之前，记录所有收到的消息
    if (messageStore !== null) {
        bot.use(messageRecorder(messageStore, logger));
    }
    // 3. 访问控制（白名单/开放/禁用）
    bot.use(accessPolicy({
        c2c: {
            mode: config.access.c2cMode,
            allow: config.access.c2cAllow.length > 0 ? config.access.c2cAllow : ['*'],
        },
        group: {
            mode: config.access.groupMode,
            allow: config.access.groupAllow.length > 0 ? config.access.groupAllow : ['*'],
        },
        onBlock: (_mCtx, reason) => {
            if (config.debug) {
                logger.debug(`Access blocked: ${reason}`);
            }
        },
    }));
    // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
    //    store 走共享单例（getHistoryStore），groupKey 带 appId 前缀，供回复后清空
    bot.use(historyBuffer({
        limit: config.historyLimit,
        store: getHistoryStore(),
        recordOnSkip: true,
        groupKey: (ctx) => {
            const gid = ctx.message.groupOpenid;
            if (ctx.message.kind !== 'group' || !gid)
                return undefined;
            return historyGroupKey(config.appId, gid);
        },
    }));
    // 4.5. 历史附件补全（纯图片/文件/语音消息在历史中保留描述，未 @ 的图片后台下载到本地）
    bot.use(historyAttachments(config, logger));
    // 4.6. 水群引擎观察（收集表情包、活跃度、间隙计时、复读）— 所有群消息都经过，门控之前
    if (pulse !== null)
        bot.use(pulse.middleware());
    // 5. 群聊 @bot 门控
    //    requireMention=true          → 仅 @ 回复
    //    requireMention=false + smart → @ 必回复；未 @ 由水群引擎（group-pulse）在聊天间隙判断是否插话
    //                                   （水群关闭时回退到旧的关键词 + 随机冷却）
    //    requireMention=false + all   → 每条群消息都回复（旧行为）
    const engageMode = config.groupEngage?.mode === 'all' ? 'all' : 'smart';
    const sleepClock = new SleepClock(config.sleep, logger);
    if (!config.requireMention && engageMode === 'smart' && pulse !== null && pulse.enabled) {
        bot.use(mentionGate({ requireMentionInGroup: true }));
    }
    else if (!config.requireMention && engageMode === 'smart') {
        const { isImplicitMention } = createGroupEngage(config.groupEngage, logger, () => sleepClock.isAsleep());
        bot.use(mentionGate({
            requireMentionInGroup: true,
            isImplicitMention,
        }));
    }
    else {
        bot.use(mentionGate({
            requireMentionInGroup: config.requireMention,
        }));
    }
    // 5.5. 睡眠门控（夜间只有主人能叫醒；其余消息仅落库）
    bot.use(sleepGate(sleepClock, bot, logger));
    // 6. 内容清洗（去 @marker、表情标签、多余空白）
    bot.use(contentSanitizer({
        parseFaceTags: true,
    }));
    // 7. 三层限流（sender / group / global）
    bot.use(rateLimiter());
    // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
    const slash = slashCommand({
        // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
        // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
        autoHelp: false,
        commands: buildCommandList({ manager, config }),
    });
    bot.use(slash.middleware);
    // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
    bot.use(questionAnswer(manager));
    // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
    bot.use(concurrencyGuard({
        strategy: 'merge',
        maxQueue: config.maxQueue,
        maxProcessingMs: config.processingTimeoutMs,
    }));
    // 10. C2C 输入状态指示
    bot.use(typingIndicator());
    // 11. 引用消息解析（记录 + 解析被引用原文）
    bot.use(quoteRef({
        maxSize: 500,
        preferMsgElements: true,
    }));
    // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
    bot.use(attachmentProcessor(config, logger));
    // 12. 上下文组装（将 history + quote + sender 组成 envelope）
    bot.use(envelopeFormatter({
        historyLimit: config.historyLimit,
        includeQuote: true,
        includeSender: true,
    }));
}
//# sourceMappingURL=middleware-setup.js.map