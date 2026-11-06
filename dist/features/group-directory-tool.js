/**
 * qqbot_group_directory 工具 — 登记 / 查询群名、群号（QQ 接口只给 group_openid）。
 * 写操作仅主人；查询所有人可用。
 */
import { GroupDirectory } from "./group-directory.js";
export const GROUP_DIRECTORY_TOOL_NAME = 'qqbot_group_directory';
const DESCRIPTION = 'Look up known QQ groups and record their group numbers / per-group instructions. '
    + 'Official group names are fetched automatically from the QQ API — never ask anyone to register a name. '
    + 'The group number (群号) is not exposed by the API: record it with action=set when the owner says e.g. "这个群号123456" '
    + '(omit `group` for the current group); `name` is only an optional manual alias. action=list shows all known groups; '
    + 'action=remove deletes an entry. Groups can be targeted by official name or number in qqbot_switch_model. '
    + 'Use `prompt` (action=set) to give a group its own duties/role instructions when the owner says e.g. "你在这个群负责…" — '
    + 'by default (prompt_mode=append) it is ADDED after the default group persona, which stays in effect; the group prompt wins only where they conflict. '
    + 'Use prompt_mode=replace only when the owner explicitly wants this group to drop the default persona entirely (e.g. "这个群换成另一个人设"). '
    + 'Permission rules always stay. Empty string clears the prompt. '
    + 'Only the verified owner may set or remove.';
export function registerGroupDirectoryTool(ctx, manager, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_group_directory 工具未注册');
        return;
    }
    tools.register({
        name: GROUP_DIRECTORY_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['set', 'list', 'remove'], description: 'set | list | remove' },
                group: { type: 'string', description: 'Group openid, official name, or number. Omit to mean the current group.' },
                name: { type: 'string', description: 'For set: optional manual alias, used only when the official name is unavailable. Empty string clears it.' },
                number: { type: 'string', description: 'For set: QQ group number (群号). Empty string clears it.' },
                note: { type: 'string', description: 'For set: optional free-form note about the group.' },
                prompt: { type: 'string', description: 'For set: this group\'s dedicated instructions (your duties/role/tone in this group, up to 4000 chars). Empty string clears it. Write it as instructions to yourself.' },
                prompt_mode: { type: 'string', enum: ['append', 'replace'], description: 'For set: append (default) = add to the default group persona; replace = this group prompt completely replaces the default persona.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    error: { type: 'string' },
                    entry: { type: 'string' },
                    groups: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                const text = v.error !== undefined ? `群目录: ${v.error}`
                    : v.groups !== undefined ? `群目录:\n${v.groups.join('\n') || '（空）'}`
                        : `群目录已更新: ${v.entry}`;
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            if (record === undefined)
                throw new Error('qqbot_group_directory 只能在 QQ 会话中使用');
            const fmt = (g) => `${GroupDirectory.label(g.openid)}${g.note ? `（${g.note}）` : ''} — openid ${g.openid}${g.openid === record.peerId ? ' ← 当前群' : ''}${g.prompt ? `\n  群专属设定（${g.promptMode === 'replace' ? '替换默认人设' : '补充默认人设'}）：${g.prompt.length > 300 ? `${g.prompt.slice(0, 300)}…` : g.prompt}` : ''}`;
            if (args.action === 'list') {
                return { ok: true, groups: GroupDirectory.list().filter((g) => g.officialName || g.name || g.number || g.prompt).map(fmt) };
            }
            if (record.lastSenderOwner !== true)
                return { ok: false, error: '只有已登记的主人可以修改群目录，请委婉拒绝。' };
            let openid;
            if (args.group === undefined || String(args.group).trim() === '' || args.group === 'current') {
                if (record.scope !== 'group')
                    return { ok: false, error: '当前是私聊，请指明要登记的群（group openid），或让主人去那个群里说' };
                openid = record.peerId;
            }
            else {
                const hit = GroupDirectory.resolve(args.group);
                openid = hit.group?.openid ?? (/^[0-9A-F]{32}$/i.test(String(args.group).trim()) ? String(args.group).trim().toUpperCase() : undefined);
                if (openid === undefined)
                    return { ok: false, error: hit.error ?? '找不到该群' };
            }
            if (args.action === 'remove') {
                const ok = GroupDirectory.remove(openid);
                return ok ? { ok: true, entry: `已删除 ${openid}` } : { ok: false, error: '群目录里没有这个群' };
            }
            if (args.action !== 'set')
                throw new Error(`未知 action: ${String(args.action)}`);
            if (args.number !== undefined && String(args.number).trim() !== '' && !/^\d{5,12}$/.test(String(args.number).trim()))
                return { ok: false, error: '群号应为 5–12 位数字' };
            const entry = GroupDirectory.set(openid, { name: args.name, number: args.number, note: args.note, prompt: args.prompt, promptMode: args.prompt_mode === 'replace' || args.prompt_mode === 'append' ? args.prompt_mode : undefined });
            logger.info(`im-qqbot: 群目录登记 ${openid} → ${JSON.stringify({ ...entry, prompt: entry.prompt ? `${entry.prompt.length} 字` : undefined })}`);
            return { ok: true, entry: fmt({ openid, ...entry }) };
        },
    });
    logger.info('im-qqbot: qqbot_group_directory 工具已注册');
}
//# sourceMappingURL=group-directory-tool.js.map
