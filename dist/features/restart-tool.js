/**
 * qqbot_restart 工具 + 自重载实现。
 *
 * QQ 会话本身跑在本插件里，直接在回合里调 plugin_manager 重装自己会撞上
 * 「HMR transactions cannot be nested」。这里改为：回合结束后、脱离当前调用链
 * （setTimeout + agents.withoutInitiator），用 pluginManager 服务把本插件
 * 停用再启用。停用会销毁本插件上下文，但已捕获的 pluginManager 引用与闭包仍会继续执行启用。
 */
import { opsLog } from "../shared/ops-log.js";
export const RESTART_TOOL_NAME = 'qqbot_restart';
const BUNDLE = '@tencent-connect/dsh-qqbot';
let pending = false;
export function scheduleSelfReload(ctx, logger, { delayMs = 2500, reason = '' } = {}) {
    if (pending)
        return { ok: true, already: true };
    let pm;
    let agents;
    try {
        pm = ctx.get('pluginManager');
        agents = ctx.get('agents');
    }
    catch { /* ignore */ }
    if (!pm?.setBundleEnabled)
        return { ok: false, error: 'pluginManager 服务不可用，没法自重启' };
    pending = true;
    opsLog('restart', { stage: 'scheduled', reason });
    logger.info(`im-qqbot: ${delayMs}ms 后自重载插件（${reason || '无说明'}）`);
    const run = async () => {
        try {
            const off = await pm.setBundleEnabled(BUNDLE, false);
            opsLog('restart', { stage: 'disabled', application: off?.application, error: off?.error?.diagnostic ?? off?.error?.code });
            await new Promise((r) => setTimeout(r, 800));
            const on = await pm.setBundleEnabled(BUNDLE, true);
            opsLog('restart', { stage: 'enabled', application: on?.application, error: on?.error?.diagnostic ?? on?.error?.code });
        }
        catch (err) {
            opsLog('restart', { stage: 'failed', error: err instanceof Error ? err.message : String(err) });
            try {
                await pm.setBundleEnabled(BUNDLE, true);
            }
            catch { /* ignore */ }
        }
        finally {
            pending = false;
        }
    };
    const t = setTimeout(() => {
        if (typeof agents?.withoutInitiator === 'function')
            agents.withoutInitiator(() => { void run(); });
        else
            void run();
    }, delayMs);
    // 不 unref：要确保会跑
    void t;
    return { ok: true };
}
export function registerRestartTool(ctx, manager, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register)
        return;
    tools.register({
        name: RESTART_TOOL_NAME,
        description: 'OWNER ONLY. Restart (hot-reload) this QQ bot plugin itself — use when the owner asks to 重启 / 重载 the bot or plugin, e.g. after code changes. '
            + 'Do NOT use plugin_manager remove_bundle/install_bundle on @tencent-connect/dsh-qqbot from a QQ chat: reloading the plugin from inside its own turn fails ("HMR transactions cannot be nested"). '
            + 'This tool schedules the reload a few seconds after your reply is sent; tell the owner it will be back in ~10 seconds. Conversation history is kept.',
        parameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Why (logged).' } },
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
            if (record !== undefined && record.lastSenderOwner !== true)
                return { ok: false, message: '只有主人可以重启机器人。' };
            const agent = record?.agent ?? exec.agent;
            if (agent?.whenIdle) {
                // 等这轮回复发完再重启
                void agent.whenIdle().then(() => scheduleSelfReload(ctx, logger, { reason: args.reason }), () => scheduleSelfReload(ctx, logger, { reason: args.reason }));
                return { ok: true, message: '本轮回复发出后约 3 秒开始重启，大约 10 秒后恢复。用一句话告诉主人即可。' };
            }
            const r = scheduleSelfReload(ctx, logger, { reason: args.reason });
            return { ok: r.ok, message: r.ok ? '约 3 秒后开始重启，大约 10 秒后恢复。' : r.error };
        },
    });
    logger.info('im-qqbot: qqbot_restart 工具已注册');
}
//# sourceMappingURL=restart-tool.js.map
