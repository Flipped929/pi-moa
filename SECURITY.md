# Security Policy

## 报告漏洞

请**不要**通过公开 issue 报告安全漏洞。
请通过 GitHub 的 [Security Advisories](../../security/advisories) 私下报告，或在 issue 中仅说"有一个安全问题需要私下沟通"并留下联系方式。

我们会在 72 小时内响应。

## 范围

重点关注：

- **scope-guard 绕过**：任何能在 `PI_MOA_SUBAGENT=1` 下写出工作目录/写入受保护路径的手法（包括 bash 变形、编码绕过、符号链接等）
- **PII 防线失效**：能以未被 redact 的形式把密钥送出到 provider payload 的路径
- **策略注入**：guard-policy.json 解析层的注入或提权
- **子代理权限提升**：子代理获得超出角色 frontmatter 声明的能力

## 已知边界（设计上接受）

- scope-guard 拦截的是"写操作"，不拦截只读信息泄露（模型读到什么取决于你给它的文件访问权）
- bash 绕行检测基于模式匹配，覆盖常见重定向/tee，不声称完备（欢迎提交绕过案例，我们会修）
- prompt 层的角色纪律是软约束；硬边界只有 scope-guard

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 0.2.x | ✅ 当前 |
| < 0.2 | ❌ 请升级 |
