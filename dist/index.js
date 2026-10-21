import { ConfigSchema } from "./config.js";
import { bootstrapGateway } from "./gateway/index.js";
import { getProfileDir, resolveEnv } from "./shared/index.js";
import { ensureCredentials, persistCredentialsToProfile, registerBoundCredentialRoutes } from "./setup/index.js";
import { MessageStore } from "./features/message-store.js";
import { registerMessageRoutes } from "./setup/message-routes.js";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const MESSAGING_SKILL_NAME = 'qqbot-messaging';
// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents'];
export const Config = ConfigSchema;
/**
 * 打开消息存储并挂载其生命周期（关闭连接 / 保留期清理 / 面板路由）。
 * 打开失败不影响机器人本身：记录错误，面板显示原因。
 */
function setupMessageStore(ctx, config, logger) {
    const options = config.messageStore ?? { enabled: true, path: '', retentionDays: 0 };
    let store = null;
    let openError = null;
    try {
        store = MessageStore.open(options);
        if (store !== null)
            logger.info(`im-qqbot: 消息存储已启用: ${store.path}`);
    }
    catch (err) {
        openError = err instanceof Error ? err.message : String(err);
        logger.error(`im-qqbot: 消息存储打开失败: ${openError}`);
    }
    const retentionDays = Number(options.retentionDays) || 0;
    ctx.effect(() => {
        let timer;
        if (store !== null && retentionDays > 0) {
            const sweep = () => {
                try {
                    const deleted = store.clear({ kind: 'older', days: retentionDays });
                    if (deleted > 0)
                        logger.info(`im-qqbot: 保留期清理删除 ${deleted} 条（>${retentionDays} 天）`);
                }
                catch (err) {
                    logger.warn(`im-qqbot: 保留期清理失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            };
            sweep();
            timer = setInterval(sweep, 6 * 3_600_000);
            timer.unref?.();
        }
        return () => {
            if (timer !== undefined)
                clearInterval(timer);
            store?.close();
            store = null;
        };
    }, 'im-qqbot.message-store');
    ctx.inject(['webServer'], (scoped) => {
        const webServer = scoped.webServer;
        if (webServer === undefined || typeof webServer.register !== 'function')
            return;
        const dispose = registerMessageRoutes(webServer, () => store, () => ({
            configured: options.enabled !== false,
            retentionDays,
            openError,
        }), logger);
        scoped.effect(() => dispose, 'im-qqbot.message-routes');
    });
    return store;
}
/**
 * 注册内置 skill「qqbot-messaging」：QQ 能力清单 + 发送格式，供 agent 按需加载。
 * skills 服务缺失或文件读取失败时仅告警。
 */
function setupMessagingSkill(ctx, logger) {
    const skillDir = fileURLToPath(new URL('../skills/qqbot-messaging/', import.meta.url));
    const skillPath = join(skillDir, 'SKILL.md');
    let content;
    try {
        content = readFileSync(skillPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    }
    catch (err) {
        logger.warn(`im-qqbot: 读取 skill 失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    ctx.inject(['skills'], (scoped) => {
        const skills = scoped.skills;
        if (typeof skills?.register !== 'function')
            return;
        try {
            skills.register({
                name: MESSAGING_SKILL_NAME,
                description: 'QQ 机器人通道能力与消息格式：Markdown 子集、qqbot_send_file 发送图片/视频/语音/文件、读取收到的附件、群聊主动参与与 [NO_REPLY] 静默、平台频控限制。',
                whenToUse: '在 QQ 群聊或私聊会话中回复、需要发送图片/文件、处理用户发来的附件，或收到 [Proactive turn] 时。',
                invocation: { modelInvocable: true, userInvocable: true },
                source: 'plugin:@tencent-connect/dsh-qqbot',
                path: skillPath,
                resourceBase: { kind: 'directory', path: skillDir },
                content,
            });
            logger.info(`im-qqbot: skill ${MESSAGING_SKILL_NAME} 已注册`);
        }
        catch (err) {
            logger.warn(`im-qqbot: skill 注册失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
// ── 插件主体 ──
export async function apply(ctx, config) {
    const agents = ctx.agents;
    const logger = ctx.logger ?? console;
    const messageStore = setupMessageStore(ctx, config, logger);
    setupMessagingSkill(ctx, logger);
    let appId = resolveEnv(config.appId, 'QQBOT_APPID');
    let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');
    // ── 凭据缺失时唤起扫码绑定 ──
    if (!appId || !appSecret) {
        logger.info('凭据未配置，启动扫码绑定...');
        // 关键：不 await 扫码结果。boot 会等 Loader 树稳定（loader.await()），
        // 无限期等待用户扫码会阻塞 Host ready——Desktop 界面无法进入、
        // Web 的 URL 延迟输出。绑定编排（路由/呈现/生命周期）在
        // ensureCredentials 的同步阶段即完成，凭据就绪后由异步链接管。
        void ensureCredentials(ctx, { logger, config: { ...config } })
            .then((credentials) => {
            if (!credentials) {
                // null 包括：扫码取消、手动提交（已另行持久化）、流程失败
                logger.info('扫码绑定流程结束（未获取凭据或已手动配置）');
                return;
            }
            // 持久化到 profile：成功则等待热更新重载，失败则用凭据直接启动。
            // 注意：不写入 process.env——resolveEnv 的 env 回退属于用户显式
            // export 的配置语义，运行时写入会与解绑清理不对齐（解绑后 HMR
            // 重载的新 fiber 仍从 env 读到旧凭据，状态停留 bound）
            const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
            if (persisted) {
                // 写入 cordis.patch.yml 会触发 dsh 热更新，自动重新加载本插件。
                logger.info('配置已保存，等待热更新重新加载...');
                return;
            }
            logger.warn('凭据未能持久化，本次进程将使用环境变量凭据启动（重启后需重新绑定）');
            // 本 fiber 已激活（ctx 有效），直接以凭据启动网关
            void bootstrapGateway(ctx, agents, {
                ...config,
                appId: credentials.appId,
                appSecret: credentials.appSecret,
            }, logger, messageStore).catch((err) => {
                logger.error(`网关启动失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        })
            .catch((err) => {
            // 全兜：unhandled rejection 会被宿主 fail-loud 判致命
            logger.error(`扫码绑定流程异常: ${err instanceof Error ? err.message : String(err)}`);
        });
        // apply 立即完成，插件 fiber 进入 ACTIVE，Host ready 不再被阻塞
        return;
    }
    // 已绑定：注册常驻路由（状态回显 + 手动编辑/更换凭据 + 配置编辑）
    registerBoundCredentialRoutes(ctx, logger, appId, { ...config });
    const resolvedConfig = { ...config, appId, appSecret };
    await bootstrapGateway(ctx, agents, resolvedConfig, logger, messageStore);
}
//# sourceMappingURL=index.js.map