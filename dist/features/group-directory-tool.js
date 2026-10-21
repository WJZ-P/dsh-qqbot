/**
 * qqbot_group_directory 工具 — 登记 / 查询群名、群号（QQ 接口只给 group_openid）。
 * 写操作仅主人；查询所有人可用。
 */
import { GroupDirectory } from "./group-directory.js";
export const GROUP_DIRECTORY_TOOL_NAME = 'qqbot_group_directory';
const DESCRIPTION = 'Record or look up QQ group names and group numbers. The QQ bot API only exposes an opaque group openid, '
    + 'so names/numbers are known only after the owner tells you. Use action=set when the owner says something like '
    + '"这个群叫XX，群号123456" (omit `group` to record the current group); action=list to show all registered groups; '
    + 'action=remove to delete an entry. Registered groups can then be targeted by name or number in qqbot_switch_model. '
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
                group: { type: 'string', description: 'Group openid, registered name, or number. Omit to mean the current group.' },
                name: { type: 'string', description: 'For set: group display name. Empty string clears it.' },
                number: { type: 'string', description: 'For set: QQ group number (群号). Empty string clears it.' },
                note: { type: 'string', description: 'For set: optional free-form note about the group.' },
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
            const fmt = (g) => `${GroupDirectory.label(g.openid)}${g.note ? `（${g.note}）` : ''} — openid ${g.openid}${g.openid === record.peerId ? ' ← 当前群' : ''}`;
            if (args.action === 'list') {
                return { ok: true, groups: GroupDirectory.list().map(fmt) };
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
            const entry = GroupDirectory.set(openid, { name: args.name, number: args.number, note: args.note });
            logger.info(`im-qqbot: 群目录登记 ${openid} → ${JSON.stringify(entry)}`);
            return { ok: true, entry: fmt({ openid, ...entry }) };
        },
    });
    logger.info('im-qqbot: qqbot_group_directory 工具已注册');
}
//# sourceMappingURL=group-directory-tool.js.map
