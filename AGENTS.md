# 维护约定（给 AI 助手）

- **每次改动完成后都要 commit 并 push 到 GitHub**（origin = https://github.com/WJZ-P/dsh-qqbot ，分支 main）。
  - 工具：`~/.tools/mingit/cmd/git.exe`、`~/.tools/gh/bin/gh.exe`（已 `gh auth login`，`gh auth setup-git` 已配置凭据）。
  - 提交信息用简短中文说明改了什么。
- **没有 `src/` 目录**（README 里的 src/*.ts 是上游布局）：宿主代码直接改 `dist/**/*.js`，面板改 `lib/client.js`，技能在 `skills/`。
- grep / glob 工具底层是 ripgrep：路径必须真实存在；DSH 自身代码在 `app.asar` 归档里，ripgrep 读不进去（报 os error 3），要查 DSH 实现请用 node 读 asar 或查看已安装插件的 `node_modules`。
- 改完 dist/ 后：`node --check` 检查语法；lib/client.js 用 `new Function('window', src)` 校验；
  然后重载插件（remove_bundle `@tencent-connect/dsh-qqbot` → install_bundle 本目录）并验证路由。
- 不要提交任何密钥 / openid / 本机私人数据（凭据在 DSH profile 配置里，不在仓库）。
