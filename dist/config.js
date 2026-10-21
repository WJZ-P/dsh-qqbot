/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
});
/** 群聊主动参与子 Schema（config 路由复用） */
export const GroupEngageSchema = Schema.object({
    mode: Schema.union(['smart', 'all']).default('smart').description('smart=@必回+随机冷却主动参与；all=每条都回复'),
    minIntervalSec: Schema.number().min(0).max(86400).default(60).description('主动参与最短间隔(秒)'),
    maxIntervalSec: Schema.number().min(0).max(86400).default(120).description('主动参与最长间隔(秒)'),
    keywords: Schema.array(Schema.string()).default([]).description('相关关键词（机器人名字/话题），留空则任何消息都可作为候选'),
});
/** 睡眠机制子 Schema */
export const SleepSchema = Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用夜间睡眠'),
    start: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('00:00').description('入睡时间 HH:mm（宿主本地时区）'),
    end: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('08:00').description('起床时间 HH:mm'),
    wakeMinutes: Schema.number().min(1).max(720).default(30).description('被主人叫醒后保持清醒的分钟数'),
    ownerIds: Schema.array(Schema.string()).default([]).description('主人 openid（同一用户群聊与私聊 openid 相同）'),
    sleepReply: Schema.string().default('呼…小喵在睡觉喵 zzZ，明早 8 点再来找我吧～').description('睡眠中被普通用户 @ 时的固定回复（不消耗 token），留空则不回复'),
    sleepReplyCooldownMin: Schema.number().min(0).max(1440).default(30).description('同一会话睡眠提示最短间隔(分钟)'),
});
/** 水群引擎子 Schema */
export const PulseSchema = Schema.object({
    enabled: Schema.boolean().default(true).description('启用水群引擎（聊天间隙判断插话 / 表情包 / 复读；替代关键词 + 随机冷却）'),
    judgeModel: Schema.string().default('').description('判断/打标签用的便宜模型（provider/model 或模型 id），留空自动选 haiku/flash'),
    stickers: Schema.boolean().default(true).description('收集群友表情包并在水群时使用'),
    repeat: Schema.boolean().default(true).description('偶尔跟着复读（2 人以上连续发同一表情包/短句）'),
    botNames: Schema.array(Schema.string()).default(['小喵']).description('机器人的称呼（群友提到时算作互动）'),
    harvestKeywords: Schema.array(Schema.string()).default(['甘城猫猫表情包', '猫猫表情包', 'Claude 表情包', '熊猫头表情包', '小猫咪表情包']).description('夜间网上搜集表情包的关键词'),
    nightly: Schema.boolean().default(true).description('睡眠时段内每天一次：生成群档案 + 网上搜集表情包'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    cwd: Schema.string().description('Agent working directory'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    triggerPrefixes: Schema.array(Schema.string()).default(['#', '＃']).description('唤起前缀：群消息以其中任一开头时视同 @，必定回复（需接收所有群消息）'),
    groupEngage: GroupEngageSchema.default({
        mode: 'smart',
        minIntervalSec: 60,
        maxIntervalSec: 120,
        keywords: [],
    }).description('群聊主动参与（requireMention=false 时生效）'),
    sleep: SleepSchema.default({
        enabled: true,
        start: '00:00',
        end: '08:00',
        wakeMinutes: 30,
        ownerIds: [],
        sleepReply: '呼…小喵在睡觉喵 zzZ，明早 8 点再来找我吧～',
        sleepReplyCooldownMin: 30,
    }).description('夜间睡眠（省 token）'),
    pulse: PulseSchema.default({
        enabled: true,
        judgeModel: '',
        stickers: true,
        repeat: true,
        botNames: ['小喵'],
        harvestKeywords: ['甘城猫猫表情包', '猫猫表情包', 'Claude 表情包', '熊猫头表情包', '小猫咪表情包'],
        nightly: true,
    }).description('水群引擎'),
    fullAccess: Schema.boolean().default(true).description('QQ 会话工具权限完全放开（danger-full-access + 不弹审批）；敏感操作由 prompt 规则按主人身份把关'),
    modelSwitch: Schema.union(['owner', 'anyone']).default('owner').description('谁可以在聊天中用一句话让机器人切换模型'),
    replaceHarnessPrompt: Schema.boolean().default(true).description('QQ 会话移除 DeepSeek Harness 桌面端的默认身份/界面提示词'),
    groupPrompt: Schema.string().description('群聊额外system prompt'),
    directPrompt: Schema.string().description('私聊额外system prompt'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
    askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    access: AccessControlSchema.default({
        c2cMode: 'open',
        c2cAllow: [],
        groupMode: 'open',
        groupAllow: [],
    }).description('访问控制'),
    showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
    debug: Schema.boolean().default(false),
    media: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
        maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
        ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    }).default({
        enabled: true,
        maxMB: 200,
        ttlHours: 24,
    }).description('富媒体理解配置'),
    vision: Schema.object({
        enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
        provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
        model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
        defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
        maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
        maxTokens: Schema.number().default(1024).description('输出 token 上限'),
        timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
    }).default({
        enabled: false,
        provider: '',
        model: '',
        defaultPrompt: 'Describe this image in detail.',
        maxBytes: 10 * 1024 * 1024,
        maxTokens: 1024,
        timeoutMs: 120000,
    }).description('视觉理解配置'),
    sendFile: Schema.object({
        restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
        extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
    }).default({
        restrictPaths: true,
        extraRoots: [],
    }).description('附件发送工具配置'),
    messageStore: Schema.object({
        enabled: Schema.boolean().default(true).description('是否将收到的消息持久化到 SQLite'),
        path: Schema.string().default('').description('数据库文件路径，留空为 ~/.dsh-qqbot/messages.db'),
        retentionDays: Schema.number().default(0).description('自动清理 N 天前的消息，0 = 永久保留'),
    }).default({
        enabled: true,
        path: '',
        retentionDays: 0,
    }).description('消息存储配置'),
});
//# sourceMappingURL=config.js.map