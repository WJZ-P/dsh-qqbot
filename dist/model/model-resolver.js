import { PrefsStore } from "./prefs-store.js";
import { SettingsReader } from "./settings-reader.js";
export class ModelResolver {
    prefs;
    settings;
    ctx;
    config;
    logger;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.prefs = new PrefsStore(config.debug ? (msg) => this.logger?.debug(msg) : undefined);
        this.settings = new SettingsReader();
    }
    /**
     * 获取指定 sessionKey 的有效模型路由（create 用）
     *
     * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
     */
    getEffectiveRoute(sessionKey) {
        return this.prefs.getOverride(sessionKey) ?? this.getScopeRoute(sessionKey) ?? this.resolveDefault();
    }
    /**
     * 场景级默认（所有群 / 所有私聊）：存为 `qqbot:<appId>:<scope>:*`
     * 优先级介于 per-peer 偏好与 config/宿主默认之间。
     */
    static scopeKeyOf(sessionKey) {
        const idx = sessionKey.lastIndexOf(':');
        return idx > 0 ? `${sessionKey.slice(0, idx)}:*` : `${sessionKey}:*`;
    }
    getScopeRoute(sessionKey) {
        return this.prefs.getOverride(ModelResolver.scopeKeyOf(sessionKey));
    }
    /** 某个会话当前模型的来源：peer / scope / default */
    getRouteSource(sessionKey) {
        if (this.prefs.hasOverride(sessionKey))
            return 'peer';
        if (this.getScopeRoute(sessionKey))
            return 'scope';
        return 'default';
    }
    /** 列出 per-peer 覆盖（key 以 prefix 开头），不含场景通配 */
    listOverrides(prefix) {
        return [...this.prefs.overrides.entries()]
            .filter(([k]) => k.startsWith(prefix) && !k.endsWith(':*'))
            .map(([key, route]) => ({ key, route }));
    }
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 优先级：per-peer 偏好 > cordis.yml 显式配置 > 默认链（settings.yaml > host）
     *
     * 这里不返回 undefined，因为未装 installModelSelection，system-prompt 的
     * {{model}} 变量直接读 agent.options.model——若无值会抛
     * "prompt variable {{model}} has no value for this assembly"。
     * 因此兜底到默认链，确保 agent.options.model 始终有值。
     */
    getResumeRoute(sessionKey) {
        const override = this.prefs.getOverride(sessionKey) ?? this.getScopeRoute(sessionKey);
        if (override)
            return override;
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        return this.resolveDefault();
    }
    /**
     * 设置 per-peer 模型偏好并持久化到隔离文件
     */
    setOverride(sessionKey, route) {
        this.prefs.setOverride(sessionKey, route);
    }
    /**
     * 清除 per-peer 模型偏好并持久化
     */
    clearOverride(sessionKey) {
        this.prefs.clearOverride(sessionKey);
    }
    /**
     * 是否存在指定 session 的模型偏好
     */
    hasOverride(sessionKey) {
        return this.prefs.hasOverride(sessionKey);
    }
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    getSessionId(sessionKey) {
        return this.prefs.getSessionId(sessionKey);
    }
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey, sessionId) {
        this.prefs.setSessionId(sessionKey, sessionId);
    }
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey) {
        this.prefs.clearSessionId(sessionKey);
    }
    /**
     * 获取指定 sessionKey 的 per-peer preset 覆盖
     */
    getPreset(sessionKey) {
        return this.prefs.getPreset(sessionKey);
    }
    /**
     * 设置 per-peer preset 覆盖并持久化
     */
    setPreset(sessionKey, presetId) {
        this.prefs.setPreset(sessionKey, presetId);
    }
    /**
     * 清除 per-peer preset 覆盖并持久化
     */
    clearPreset(sessionKey) {
        return this.prefs.clearPreset(sessionKey);
    }
    /**
     * 解析默认模型路由（不含 per-peer 偏好）
     *
     * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
     * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault() {
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        const fromSettings = this.settings.readDefaultRoute();
        if (fromSettings)
            return fromSettings;
        const fromHost = this.readFromHost();
        if (fromHost)
            return fromHost;
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
    }
    /**
     * 列出所有可用模型
     *
     * 优先走 ctx.llm 服务动态发现，服务不可用或失败时回退 settings.yaml 静态配置。
     */
    async listModels() {
        const llm = this.getLlmService();
        if (!llm)
            return this.settings.readModels();
        try {
            const providers = llm.listProviders();
            const entries = [];
            for (const provider of providers) {
                const providerId = typeof provider === 'string' ? provider : provider.id;
                try {
                    const models = await llm.listModels(providerId);
                    for (const model of models) {
                        entries.push({ provider: providerId, id: model.id, name: model.name });
                    }
                }
                catch (err) {
                    // 单个 provider 失败，跳过
                    this.logger?.debug(`ModelResolver: provider ${providerId} 模型列表获取失败: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (entries.length > 0)
                return entries;
        }
        catch (err) {
            this.logger?.warn(`ModelResolver: 动态发现模型失败，回退 settings.yaml: ${err instanceof Error ? err.message : String(err)}`);
        }
        return this.settings.readModels();
    }
    /**
     * 按分组（provider）列出当前可用模型，30 秒缓存。
     * 每个分组 = 宿主里的一个 provider 路由（如 Our Free Model、deepseek-official）。
     * 免费模型插件只广播探测可用的模型，所以「在列表里」≈「可用」；
     * 本插件另外把最近调用失败的模型临时标为不可用（markBad，15 分钟）。
     */
    async listGrouped(force = false) {
        if (!force && this.groupCache && Date.now() - this.groupCache.at < 30_000)
            return this.groupCache.groups;
        const llm = this.getLlmService();
        const groups = [];
        if (llm) {
            let providers = [];
            try {
                providers = llm.listProviders();
            }
            catch { /* ignore */ }
            for (const p of providers) {
                const id = typeof p === 'string' ? p : p.id;
                let label = typeof p === 'string' ? '' : (p.name ?? p.label ?? '');
                try {
                    const info = typeof llm.providerInfo === 'function' ? llm.providerInfo(id) : undefined;
                    label = info?.name ?? label;
                }
                catch { /* ignore */ }
                let models = [];
                let failed = false;
                try {
                    models = (await llm.listModels(id)).map((m) => ({ id: m.id, name: m.name, vision: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : undefined }));
                }
                catch {
                    failed = true;
                }
                groups.push({ provider: id, label: label || id, models, failed });
            }
        }
        else {
            const byP = new Map();
            for (const m of this.settings.readModels()) {
                if (!byP.has(m.provider))
                    byP.set(m.provider, { provider: m.provider, label: m.provider, models: [], failed: false });
                byP.get(m.provider).models.push({ id: m.id, name: m.name });
            }
            groups.push(...byP.values());
        }
        this.groupCache = { at: Date.now(), groups };
        return groups;
    }
/** QQ 机器人的默认模型：插件配置 > 所有群默认 > 所有私聊默认 > 宿主默认 */
    botDefaultRoute() {
        if (this.config.provider && this.config.model)
            return { provider: this.config.provider, model: this.config.model };
        const appKey = (scope) => `qqbot:${this.config.appId}:${scope}:*`;
        return this.prefs.getOverride(appKey('group')) ?? this.prefs.getOverride(appKey('c2c')) ?? this.resolveDefault();
    }
    /** 同一分组里找支持看图的模型（当前模型能看图就用它；不跨分组） */
    async visionInGroup(route) {
        const groups = await this.listGrouped();
        const g = groups.find((x) => x.provider === route?.provider);
        if (!g || g.failed)
            return { route };
        const usable = g.models.filter((m) => !this.isBad(g.provider, m.id));
        const self = usable.find((m) => m.id === route.model);
        if (self && self.vision !== false)
            return { route };
        const alt = usable.find((m) => m.vision === true);
        if (alt)
            return { route: { provider: g.provider, model: alt.id }, fallback: true };
        return { error: `默认模型所在分组「${g.label}」里没有能看图的可用模型，没法给表情包打标签` };
    }
    /** 某模型调用失败：在本插件内临时视为不可用 */
    markBad(route, minutes = 15) {
        if (!route?.provider || !route?.model)
            return;
        this.bad = this.bad ?? new Map();
        this.bad.set(`${route.provider}/${route.model}`, Date.now() + minutes * 60_000);
    }
    clearBad(route) {
        this.bad?.delete(`${route.provider}/${route.model}`);
    }
    isBad(provider, model) {
        const until = this.bad?.get(`${provider}/${model}`);
        return until !== undefined && until > Date.now();
    }
    /**
     * 确认路由可用；不可用时只在同一分组里找替补（跨分组可能有费用差异，绝不自动跨组）。
     * 返回 { route, fallback?, from? } 或 { error, group }
     */
    async pickInGroup(route) {
        if (!route?.provider)
            return { route };
        let groups;
        try {
            groups = await this.listGrouped();
        }
        catch {
            return { route }; // 查不到列表时不拦截
        }
        if (!groups.length)
            return { route };
        const g = groups.find((x) => x.provider === route.provider);
        if (!g)
            return { error: `模型分组「${route.provider}」不存在（插件被停用或卸载了？）`, group: route.provider };
        if (g.failed)
            return { route }; // 该分组列表拉取失败：不判定，照常用
        const usable = g.models.filter((m) => !this.isBad(g.provider, m.id));
        if (usable.some((m) => m.id === route.model))
            return { route };
        if (!usable.length)
            return { error: `当前模型分组「${g.label}」里暂时没有可用模型`, group: g.label };
        // 优先挑名字最像的（同系列），否则第一个
        const base = String(route.model).toLowerCase().split(/[-_.:/]/)[0];
        const alt = usable.find((m) => m.id.toLowerCase().startsWith(base)) ?? usable[0];
        return { route: { provider: g.provider, model: alt.id }, fallback: true, from: route.model, group: g.label, name: alt.name ?? alt.id };
    }
    /**
     * 列出可用 provider 名称
     */
    listProviders() {
        const llm = this.getLlmService();
        if (llm) {
            const providers = llm.listProviders();
            if (providers.length > 0) {
                const first = providers[0];
                if (typeof first === 'string')
                    return providers;
                return providers.map((p) => p.id);
            }
        }
        return this.settings.readProviders();
    }
    // ── 私有方法 ──
    readFromHost() {
        try {
            const agentDefaultModel = this.getService('agentDefaultModel');
            if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
                const selection = agentDefaultModel.currentSelection();
                if (selection?.provider && selection?.model) {
                    return { provider: selection.provider, model: selection.model };
                }
            }
        }
        catch (err) {
            if (this.config.debug) {
                this.logger?.debug(`ModelResolver: host service failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return undefined;
    }
    /** 统一的 Cordis 服务访问（可选获取：服务未注入时静默返回 undefined，避免 Proxy 抛错） */
    getService(name) {
        try {
            const ctxAny = this.ctx;
            return typeof ctxAny.get === 'function' ? ctxAny.get(name) : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** 获取 ctx.llm 服务（最小接口收窄，不可用时返回 undefined） */
    getLlmService() {
        try {
            const llm = this.getService('llm');
            if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
                return llm;
            }
        }
        catch (err) {
            this.logger?.warn(`ModelResolver: ctx.llm 服务访问失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        return undefined;
    }
}
//# sourceMappingURL=model-resolver.js.map