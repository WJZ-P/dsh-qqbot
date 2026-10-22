/**
 * 主人专用：清空当前群 / 私聊的上下文，开新会话重来。
 *
 * 触发：/new /reset /clear，或口语「重置 / 清空上下文」「重开会话」「忘掉之前的」等。
 * 群里只有主人能用（以前 /reset 谁都能发，群友可以随手把机器人的记忆清掉）。
 * 新会话会重新组装 system prompt，所以改了群人设后用它能立刻按新人设说话。
 * 指令本身不进 LLM。放在 slashCommand 之前，截住斜杠版本。
 */
const SLASH_RE = /^\/(new|reset|clear)\s*$/i;
const TALK_RE = /^(帮我|给我)?(重置|清空|清除|清理|重开|刷新)(一下)?(当前|本群|这个群|群里的?|你的)?(上下文|会话|对话|记忆|聊天记录)(吧|一下)?[。.!！~～]*$|^(忘掉|忘记)(之前|以前|前面)(的|说的)?(所有|全部)?(内容|话|东西|事情)?[。.!！~～]*$|^(新开|重开)(一个)?(会话|对话)[。.!！~～]*$/;
export function contextReset(manager, bot, logger) {
    return async (ctx, next) => {
        const raw = typeof ctx.message.content === 'string' ? ctx.message.content : '';
        const text = raw.replace(/^(\s|<@!?[^>]*>)+/, '').trim();
        const slash = SLASH_RE.test(text);
        const talk = !slash && TALK_RE.test(text);
        if (!slash && !talk) {
            await next();
            return;
        }
        const msg = ctx.message;
        const isGroup = msg.kind === 'group';
        const target = {
            scope: isGroup ? 'group' : 'c2c',
            targetId: isGroup ? (msg.groupOpenid ?? msg.senderId) : msg.senderId,
            msgId: msg.messageId,
        };
        const owner = ctx.state.owner === true;
        // 群里非主人：口语版当普通聊天放行；斜杠版直接拒绝
        if (isGroup && !owner) {
            if (talk) {
                await next();
                return;
            }
            await bot.sendMarkdown(target, '只有主人能清空本群的上下文哦').catch(() => { });
            ctx.stop('context-reset');
            return;
        }
        const peerId = target.targetId;
        try {
            await manager.remove(target.scope, peerId);
            logger.info(`im-qqbot: ${owner ? '主人' : '私聊用户'}清空上下文 ${target.scope}:${peerId}`);
            await bot.sendMarkdown(target, '好，之前聊的都清空了，下一条消息开始从头来').catch(() => { });
        }
        catch (err) {
            logger.warn(`im-qqbot: 清空上下文失败 ${target.scope}:${peerId}: ${err instanceof Error ? err.message : String(err)}`);
            await bot.sendMarkdown(target, `清空失败：${err instanceof Error ? err.message : String(err)}`).catch(() => { });
        }
        ctx.stop('context-reset');
    };
}
//# sourceMappingURL=context-reset.js.map
