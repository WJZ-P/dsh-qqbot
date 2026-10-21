/**
 * qqbot_switch_model 工具 — 让 agent 根据一句自然语言切换模型，支持粒度：
 *   - target=current（默认）：当前群 / 私聊
 *   - target=all-groups：所有群（场景默认，并清掉各群单独设置）
 *   - target=all-private：所有私聊
 *   - target=<群名 / 群号 / group openid>：群目录中登记过的某个群
 *
 * 优先级：单个会话设置 > 场景默认（所有群/所有私聊）> 插件配置 provider/model > 宿主默认模型。
 * 默认仅主人可切换（sleep.ownerIds）；config.modelSwitch='anyone' 时只放开 target=current。
 * 当前会话的重建会替换正在运行的 agent，推迟到本轮结束（whenIdle）后执行。
 */
import { GroupDirectory } from "../features/group-directory.js";
import { modelGroupsMarkdown } from "./model-groups-md.js";
export const SWITCH_MODEL_TOOL_NAME = 'qqbot_switch_model';
const DESCRIPTION = 'List, switch, or reset the LLM model for QQ conversations, at a chosen granularity. '
    + 'Use when the QQ user asks to change model (e.g. "换成 sonnet", "所有群都用 haiku", "XX群换回默认模型") or asks which models are used. '
    + 'action=list returns `markdown`: currently usable models grouped by provider group (e.g. Our Free Model, deepseek-official) plus the per-chat layout — forward that markdown as-is when asked which models exist. '
    + 'action=switch takes a model name/id/alias (fuzzy matched among usable models); pass `group` to restrict matching to one provider group. '
    + 'If the active model becomes unusable the plugin auto-falls back only within the same group; if that whole group is unusable it reports an error instead of crossing groups (cost). '
    + 'action=reset removes the setting at that target so it falls back (single chat → all-groups/all-private default → host default). '
    + 'target: "current" (default, this chat), "all-groups", "all-private", or a group name / group number / group openid registered via qqbot_group_directory. '
    + 'Changes keep conversation history; the current chat switches after this reply. Only the verified owner may change anything other than target=current.';
function norm(s) {
    return String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}
/** 模糊匹配：provider/id > id > 别名 > 唯一子串 */
export function matchModel(models, query) {
    const q = norm(query);
    if (!q)
        return { error: '请提供模型名' };
    const full = (m) => norm(`${m.provider}/${m.id}`);
    const tiers = [
        (m) => full(m) === q,
        (m) => norm(m.id) === q,
        (m) => m.name !== undefined && norm(m.name) === q,
        (m) => full(m).includes(q) || (m.name !== undefined && norm(m.name).includes(q)),
    ];
    for (const test of tiers) {
        const hits = models.filter(test);
        if (hits.length === 1)
            return { model: hits[0] };
        if (hits.length > 1)
            return { error: `「${query}」匹配到多个模型，请说得更具体`, candidates: hits };
    }
    return { error: `没有找到模型「${query}」` };
}
const describe = (m) => (m.name ? `${m.name} (${m.provider}/${m.id})` : `${m.provider}/${m.id}`);
export function registerSwitchModelTool(ctx, manager, config, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('im-qqbot: tools 服务不可用，qqbot_switch_model 工具未注册');
        return;
    }
    const ownerOnly = config.modelSwitch !== 'anyone';
    tools.register({
        name: SWITCH_MODEL_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'switch', 'reset'], description: 'list | switch | reset' },
                model: { type: 'string', description: 'For action=switch: model alias, id, or provider/id, e.g. "sonnet5.5", "claude-haiku-5-5".' },
                group: { type: 'string', description: 'Optional provider group id or label to restrict model matching, e.g. "our-free-model".' },
                target: { type: 'string', description: '"current" (default), "all-groups", "all-private", or a registered group name / group number / group openid.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    unchanged: { type: 'boolean' },
                    current: { type: 'string' },
                    target: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                    note: { type: 'string' },
                    error: { type: 'string' },
                    canSwitch: { type: 'boolean' },
                    models: { type: 'array', items: { type: 'string' } },
                    markdown: { type: 'string' },
                    layout: { type: 'array', items: { type: 'string' } },
                    candidates: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                const text = v.to !== undefined ? `模型切换（${v.target}）: ${v.from} → ${v.to}`
                    : v.error !== undefined ? `模型切换失败: ${v.error}`
                        : v.markdown !== undefined ? `${v.markdown}\n\n${(v.layout ?? []).join('\n')}`
                        : v.layout !== undefined ? `当前模型: ${v.current}\n${v.layout.join('\n')}`
                            : `当前模型: ${v.current}`;
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const record = exec.agent !== undefined ? manager.findByAgent(exec.agent) : undefined;
            if (record === undefined)
                throw new Error('qqbot_switch_model 只能在 QQ 会话中使用');
            const isOwner = record.lastSenderOwner === true;
            const groups = await manager.listModelGroups();
            const models = groups.flatMap((g) => g.models.filter((m) => !manager.modelResolver.isBad(g.provider, m.id)).map((m) => ({ provider: g.provider, id: m.id, name: m.name, group: g.label })));
            if (!models.length)
                models.push(...(await manager.listAvailableModels()));
            const show = (route) => {
                if (!route)
                    return '（未设置）';
                const m = models.find((x) => x.provider === route.provider && x.id === route.model);
                return describe(m ?? { provider: route.provider, id: route.model });
            };
            const curRoute = manager.getEffectiveModel(record.scope, record.peerId);
            const currentText = show(curRoute);
            const action = args.action;
            if (action === 'list') {
                const lay = manager.describeModelLayout();
                const layout = [
                    `兜底默认（插件配置 / 宿主默认）: ${show(lay.fallback)}`,
                    `所有群: ${lay.group.scopeDefault ? show(lay.group.scopeDefault) : '跟随兜底默认'}`,
                    `所有私聊: ${lay.c2c.scopeDefault ? show(lay.c2c.scopeDefault) : '跟随兜底默认'}`,
                    ...lay.group.peers.map((p) => `群 ${GroupDirectory.label(p.peerId)}: ${show(p.route)}`),
                    ...lay.c2c.peers.map((p) => `私聊 ${p.peerId.slice(0, 8)}…: ${show(p.route)}`),
                ];
                const markdown = await modelGroupsMarkdown(manager, record.activeRoute ?? curRoute);
                return { current: currentText, markdown, layout, canSwitch: !ownerOnly || isOwner };
            }
            if (action !== 'switch' && action !== 'reset')
                throw new Error(`未知 action: ${String(action)}`);
            // ── 解析目标 ──
            const rawTarget = String(args.target ?? 'current').trim();
            const t = rawTarget.toLowerCase();
            let kind;
            let scope = record.scope;
            let peerId = record.peerId;
            let targetText;
            if (t === '' || t === 'current' || t === '当前' || t === 'this') {
                kind = 'peer';
                targetText = record.scope === 'group' ? `本群 ${GroupDirectory.label(record.peerId)}` : '本私聊';
            }
            else if (t === 'all-groups' || t === 'all-group' || t === '所有群') {
                kind = 'scope';
                scope = 'group';
                targetText = '所有群';
            }
            else if (t === 'all-private' || t === 'all-c2c' || t === '所有私聊') {
                kind = 'scope';
                scope = 'c2c';
                targetText = '所有私聊';
            }
            else {
                const hit = GroupDirectory.resolve(rawTarget);
                if (hit.group === undefined) {
                    return { ok: false, error: hit.error, candidates: (hit.candidates ?? GroupDirectory.list()).map((g) => `${GroupDirectory.label(g.openid)} (${g.openid})`), current: currentText };
                }
                kind = 'peer';
                scope = 'group';
                peerId = hit.group.openid;
                targetText = `群 ${GroupDirectory.label(peerId)}`;
            }
            const isCurrent = kind === 'peer' && scope === record.scope && peerId === record.peerId;
            if (ownerOnly ? !isOwner : (!isCurrent && !isOwner)) {
                return {
                    ok: false,
                    error: `只有已登记的主人可以切换${isCurrent ? '' : '其他群 / 全局的'}模型。请委婉告诉对方没有权限。`,
                    current: currentText,
                };
            }
            let route = null;
            if (action === 'switch') {
                const gq = String(args.group ?? '').trim().toLowerCase();
                const pool = gq ? models.filter((m) => m.provider.toLowerCase() === gq || String(m.group ?? '').toLowerCase().includes(gq)) : models;
                const hit = matchModel(pool, args.model);
                if (hit.model === undefined) {
                    return { ok: false, error: hit.error, candidates: (hit.candidates ?? models).map(describe), current: currentText };
                }
                route = { provider: hit.model.provider, model: hit.model.id };
            }
            const fromText = kind === 'scope'
                ? (manager.describeModelLayout()[scope].scopeDefault ? show(manager.describeModelLayout()[scope].scopeDefault) : '跟随兜底默认')
                : show(manager.getEffectiveModel(scope, peerId));
            const toText = route ? show(route) : (kind === 'scope' ? '兜底默认' : '上一级默认');
            // ── 执行 ──
            const deferCurrent = (fn) => {
                const agent = record.agent;
                void (async () => {
                    try {
                        await agent.whenIdle();
                        await fn();
                    }
                    catch (err) {
                        logger.warn(`im-qqbot: 模型切换失败: ${err instanceof Error ? err.message : String(err)}`);
                    }
                })();
            };
            if (kind === 'scope') {
                const skipKey = scope === record.scope ? record.sessionKey : undefined;
                await manager.setScopeModel(scope, route, { clearPeers: true, skipKey });
                if (skipKey !== undefined)
                    deferCurrent(() => manager.resetModelOverride(record.scope, record.peerId));
            }
            else if (isCurrent) {
                deferCurrent(() => (route ? manager.setModelOverride(scope, peerId, route) : manager.resetModelOverride(scope, peerId)));
            }
            else if (route) {
                await manager.setModelOverride(scope, peerId, route);
            }
            else {
                await manager.resetModelOverride(scope, peerId);
            }
            logger.info(`im-qqbot: qqbot_switch_model [${targetText}] ${fromText} → ${toText}`);
            return {
                ok: true,
                target: targetText,
                from: fromText,
                to: toText,
                note: (kind === 'scope' ? '已清除该范围内各会话的单独设置。' : '')
                    + (isCurrent || (kind === 'scope' && scope === record.scope) ? '当前会话在本轮回复后生效；' : '')
                    + '对话历史保留。用一句话告诉对方结果即可。',
            };
        },
    });
    logger.info('im-qqbot: qqbot_switch_model 工具已注册');
}
//# sourceMappingURL=switch-model-tool.js.map
