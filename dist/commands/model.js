import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { modelGroupsMarkdown } from "../model/model-groups-md.js";
export function modelCommand({ manager, config }) {
    return {
        name: 'model',
        category: 'agent',
        description: '查看或切换模型（用法: /model [provider/model]）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim();
            // 无参数：显示当前模型 + 可用模型列表（可点击）
            if (!args) {
                const current = manager.getEffectiveModel(scope, peerId);
                const lines = ['### 🤖 可用模型（按分组，点击切换）', '', await modelGroupsMarkdown(manager, current, { clickable: true })];
                lines.push('', '手动指定: `/model provider/model`');
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // 解析 provider/model 格式
            let provider;
            let model;
            if (args.includes('/')) {
                const parts = args.split('/');
                provider = parts[0] ?? '';
                model = parts.slice(1).join('/');
            }
            else {
                // 仅指定 model 名，provider 从当前路由继承
                const current = manager.getEffectiveModel(scope, peerId);
                provider = current?.provider ?? 'deepseek-official';
                model = args;
            }
            if (!provider || !model) {
                return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-v4-flash';
            }
            await manager.setModelOverride(scope, peerId, { provider, model });
            return `✅ 模型已切换: ${provider}/${model}\n立即生效，对话上下文保留。`;
        },
    };
}
//# sourceMappingURL=model.js.map