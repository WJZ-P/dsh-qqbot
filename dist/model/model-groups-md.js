/**
 * 把可用模型按分组渲染成 Markdown（/model 命令与 qqbot_switch_model list 共用）。
 */
export async function modelGroupsMarkdown(manager, current, { clickable = false, maxPerGroup = 30 } = {}) {
    const groups = await manager.listModelGroups();
    const resolver = manager.modelResolver;
    const lines = [];
    let cur = '宿主默认模型';
    if (current?.provider) {
        const g = groups.find((x) => x.provider === current.provider);
        const m = g?.models.find((x) => x.id === current.model);
        cur = `${m?.name ?? current.model}（分组：${g?.label ?? current.provider}）`;
    }
    lines.push(`**当前模型：** ${cur}`, '');
    let total = 0;
    const empty = [];
    for (const g of groups) {
        if (!g.models.length && current?.provider !== g.provider) {
            empty.push(g.label);
            continue;
        }
        const usable = g.models.filter((m) => !resolver?.isBad?.(g.provider, m.id));
        const bad = g.models.length - usable.length;
        total += usable.length;
        lines.push(`### ${g.label}${g.label !== g.provider ? `（${g.provider}）` : ''} · ${g.failed ? '列表获取失败' : `${usable.length} 个可用`}${bad ? `，${bad} 个暂不可用` : ''}`);
        if (!usable.length) {
            lines.push('- （暂无可用模型）', '');
            continue;
        }
        for (const m of usable.slice(0, maxPerGroup)) {
            const isCur = current?.provider === g.provider && current?.model === m.id;
            const path = `${g.provider}/${m.id}`;
            const label = m.name && m.name !== m.id ? `${m.name} \`${m.id}\`` : `\`${m.id}\``;
            lines.push(clickable
                ? `- ${isCur ? '✅ ' : ''}<qqbot-cmd-input text="/model ${path}" show="${m.name ?? m.id}"/>`
                : `- ${isCur ? '✅ ' : ''}${label}`);
        }
        if (usable.length > maxPerGroup)
            lines.push(`- ……还有 ${usable.length - maxPerGroup} 个`);
        lines.push('');
    }
    if (empty.length)
        lines.push(`（另有 ${empty.length} 个分组暂无模型：${empty.join('、')}）`, '');
    if (!groups.length)
        lines.push('（没有拿到模型列表）');
    lines.push(`共 ${total} 个可用模型。当前模型不可用时只在**同一分组**里自动找替补，同组都不可用会直接报错（不会自动跨分组，避免费用变化）。`);
    return lines.join('\n');
}
//# sourceMappingURL=model-groups-md.js.map
