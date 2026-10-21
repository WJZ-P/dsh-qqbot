/**
 * qqbot_global_prompt 工具 — 查看 / 修改总 prompt（config.groupPrompt 群聊、config.directPrompt 私聊）。
 *
 * 仅主人触发的回合可写；查看也仅限主人（prompt 里可能有不想公开的设定）。
 * 修改立即作用于内存配置（下一轮起生效），并在本轮结束后写回 cordis.patch.yml 持久化
 * ——写回会触发插件重载、重置会话，所以等 agent 空闲后再写，避免打断本轮回复。
 */
import { updateProfileConfig } from '../setup/persist.js';
import { getProfileDir } from '../shared/utils.js';
export const GLOBAL_PROMPT_TOOL_NAME = 'qqbot_global_prompt';
const MAX_LEN = 20000;
const KEY = { group: 'groupPrompt', direct: 'directPrompt' };
const LABEL = { group: '群聊总 prompt', direct: '私聊总 prompt' };
export function registerGlobalPromptTool(ctx, manager, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_global_prompt 未注册');
        return;
    }
    let pending = null; // { patch, timer }
    const persistLater = (record, patch) => {
        pending = { ...(pending ?? {}), ...patch };
        void (async () => {
            try {
                await record.agent?.whenIdle?.();
            }
            catch { /* ignore */ }
            await new Promise((r) => setTimeout(r, 3000));
            if (!pending)
                return;
            const p = pending;
            pending = null;
            const ok = updateProfileConfig(p, getProfileDir() ?? undefined, logger);
            logger.info(`im-qqbot: 总 prompt 已${ok ? '' : '未能'}写回配置（${Object.keys(p).join(', ')}）`);
        })();
    };
    tools.register({
        name: GLOBAL_PROMPT_TOOL_NAME,
        description: 'View or edit the GLOBAL QQ prompt (persona/rules for all groups = scope "group", or all private chats = scope "direct"). OWNER ONLY: only works in a turn triggered by the verified owner; refuse politely otherwise. '
            + 'Actions: view; append (add text at the end); replace (old_text → new_text, exact substring); set (overwrite the whole prompt — view it first and keep everything the owner did not ask to change). '
            + 'For one group only, use qqbot_group_directory prompt instead. Takes effect from the next message; saved permanently after this turn (plugin reloads, sessions reset).',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['view', 'append', 'replace', 'set'] },
                scope: { type: 'string', enum: ['group', 'direct', 'both'], description: 'Which prompt: group chats, private chats, or both (default group).' },
                text: { type: 'string', description: 'append / set: the text.' },
                old_text: { type: 'string', description: 'replace: exact substring to find.' },
                new_text: { type: 'string', description: 'replace: replacement (empty string deletes).' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
                required: ['ok', 'message'],
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            // 非 QQ 会话（桌面端）视为主人
            if (record !== undefined && record.lastSenderOwner !== true)
                return { ok: false, message: '只有主人可以查看或修改总 prompt，请委婉拒绝。' };
            const scopes = args.scope === 'both' ? ['group', 'direct'] : [args.scope === 'direct' ? 'direct' : 'group'];
            const action = String(args.action);
            if (action === 'view') {
                return {
                    ok: true,
                    message: scopes.map((s) => `【${LABEL[s]}】（${(config[KEY[s]] ?? '').length} 字）\n${config[KEY[s]] || '（空）'}`).join('\n\n'),
                };
            }
            const patch = {};
            for (const s of scopes) {
                const cur = String(config[KEY[s]] ?? '');
                let next;
                if (action === 'append') {
                    const t = String(args.text ?? '').trim();
                    if (!t)
                        return { ok: false, message: 'append 需要 text' };
                    next = cur ? `${cur.replace(/\s+$/, '')}\n${t}` : t;
                }
                else if (action === 'replace') {
                    const old = String(args.old_text ?? '');
                    if (!old)
                        return { ok: false, message: 'replace 需要 old_text' };
                    const n = cur.split(old).length - 1;
                    if (n === 0)
                        return { ok: false, message: `${LABEL[s]}里找不到这段原文，先 view 看看准确文字` };
                    if (n > 1)
                        return { ok: false, message: `${LABEL[s]}里这段原文出现了 ${n} 次，请多带一点上下文` };
                    next = cur.replace(old, String(args.new_text ?? ''));
                }
                else if (action === 'set') {
                    if (typeof args.text !== 'string')
                        return { ok: false, message: 'set 需要 text（整段新 prompt）' };
                    next = args.text.trim();
                }
                else
                    return { ok: false, message: `未知 action: ${action}` };
                if (next.length > MAX_LEN)
                    return { ok: false, message: `prompt 太长（${next.length} 字，上限 ${MAX_LEN}）` };
                patch[KEY[s]] = next;
            }
            Object.assign(config, patch); // 内存立即生效（下一轮 assemble 读取）
            if (record !== undefined)
                persistLater(record, patch);
            else {
                const ok = updateProfileConfig(patch, getProfileDir() ?? undefined, logger);
                if (!ok)
                    return { ok: false, message: '写入配置失败' };
            }
            logger.info(`im-qqbot: 主人修改总 prompt（${action} ${scopes.join('+')}）`);
            return {
                ok: true,
                message: `已更新${scopes.map((s) => LABEL[s]).join('和')}（${scopes.map((s) => `${patch[KEY[s]].length} 字`).join(' / ')}），下一条消息起生效；本轮结束后会永久保存，插件会自动重载一次。`,
            };
        },
    });
    logger.info('im-qqbot: qqbot_global_prompt 工具已注册');
}
//# sourceMappingURL=global-prompt-tool.js.map
