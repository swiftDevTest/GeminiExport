# 代码深度扫描与修复报告

> 扫描日期：2026-07-30
>
> 扫描范围：GeminiExport 全量代码与 `1.3.0` 新增变更
>
> 最终验证：49 项测试全部通过，依赖漏洞 0 个，商店 ZIP 打包成功（88 个文件）

---

## 一、已修复问题

### 0. 高危：支付 Webhook 被过期用户 ID 阻断并持续返回 500

**涉及文件**

- `supabase/functions/payment-webhook/index.ts`
- `supabase/functions/product-payment-webhook/index.ts`
- `tests/membership-product-sync.test.mjs`

**根因**

Webhook 的签名验证通过后，去重审计记录会在用户归属校验之前，直接把
`custom_data.user_id` 写入带外键约束的 `user_id`。当 Paddle 重放的是已删除用户、
测试用户或过期关联时，数据库拒绝插入，导致 Webhook 返回 500 并反复重试。

**修复**

- 去重锁和忽略事件的审计记录不再信任外部 payload 中的用户 ID，先写 `null`。
- 实际交易、订阅和退款处理仍使用原有的邮箱校验及 transaction/subscription/customer
  历史归属反查，不放宽权益授权边界。
- 同时修复产品隔离版和旧版 Webhook，避免共享项目的两条入口继续产生相同故障。
- 增加静态回归断言，禁止上述两条路径再次直接写入 `info.userId`。

### 1. 高危：本地权益缓存可被伪造为 Pro

**涉及文件**

- `src/modules/entitlements.js`
- `src/content.js`
- `tests/membership-product-sync.test.mjs`
- `tests/release-regressions.test.mjs`

**根因**

- `decryptCachedEntitlementState` 的注释要求拒绝明文缓存，旧实现却直接返回明文对象。
- AES-GCM 密钥由公开的 extension ID 派生，只能避免缓存直接裸露，不能把客户端缓存变成服务器证明。
- `content.js` 只记录最近一次服务器检查时间，没有将该时间与当时验证过的用户、套餐绑定。服务器验证 Free 后再篡改缓存为 Pro，可能复用 5 分钟 TTL。
- 保存前的二次校验失败时，旧逻辑允许任何本地 `isProUser` 状态继续导出。

**修复**

1. 明文、非法或无法解密的缓存直接返回 `null` 并从 storage 删除。
2. WebCrypto 不可用或加密失败时不再降级写入明文权益缓存。
3. 增加服务器验证指纹，绑定当前用户 ID、套餐和 `updated_at`。
4. Pro 的短时离线回退必须同时满足：
   - 当前状态为 Pro；
   - 本页面会话内近期完成过服务器校验；
   - 当前身份/套餐指纹与服务器校验时完全一致。
5. 服务器未返回 profile 时不能据此确认缓存中的 Pro。
6. 服务器明确返回 `allowed: false` 时立即以服务器结果为准，旧 Pro 缓存不能覆盖。
7. 专业模板、主题等本地权限判断移到服务器预检之后。
8. 本地配额降级会把未验证的缓存套餐归一化为 Free，不能用伪造 Pro 绕过额度。
9. 文件、Notion、Obsidian 三条批量路径都必须先完成服务器校验，并确认当前 Pro 指纹仍有效。

**说明**

客户端拥有者始终可以修改本地扩展代码，因此本地加密不能作为最终授权边界。当前实现把实际导出授权建立在服务器结果上，本地缓存只负责界面加速和近期已验证状态的短时容错。

---

### 2. 高危：信用卡与电话号码脱敏存在误伤和漏检

**涉及文件**

- `src/modules/redaction.js`
- `tests/redaction-validation.test.mjs`

**根因**

- 旧信用卡规则匹配任意 13–19 位数字，容易误伤时间戳、订单号和业务 ID。
- 初版修复只允许“16 位且带分隔符”，会漏掉无分隔符 Visa、15 位 Amex 和部分 19 位卡号。
- phone 规则可以从更长数字串尾部截取 10/11 位，导致时间戳和卡号先被误判为电话。

**修复**

- 信用卡先提取 13–19 位候选，再执行：
  - Luhn 校验；
  - 重复数字排除；
  - 无分隔符号码的卡组织前缀校验；
  - 带分隔符号码的分组合理性校验。
- 支持紧凑卡号、4-4-4-4、Amex 4-6-5 等格式。
- 电话号码两侧禁止紧邻数字，避免从长 ID 中截取子串。
- 电话规则支持带国际区号的 8–15 位号码，以及常见 10 位和中国大陆 11 位号码。

**回归样例**

- `4111111111111111`：脱敏。
- `3782 822463 10005`：脱敏。
- `1712345678901`：保留。
- `4111111111111112`：保留。
- `+49 30 901820`：脱敏。
- 17 位业务 ID：保留。

---

### 3. 中危：已停用 analytics 仍保留整套死代码

**涉及文件**

- `src/background.js`
- `src/content.js`
- `manifest.json`
- `package.json`
- `src/modules/analytics.js`（已删除）

**根因**

background 的 analytics 处理函数已经是 no-op，但 listener、队列、定时器和辅助函数仍存在；content 仍保留埋点调用，manifest 仍注入一个内部 `track/flush/identify` 全部为空实现的模块。

**修复**

- 删除 background 中全部 analytics 常量、状态、队列、listener 和遗留辅助函数。
- 删除 content 中所有 `CHATVAULT_ANALYTICS` 调用。
- 从 manifest 和语法检查脚本中移除 analytics 模块。
- 删除 `src/modules/analytics.js`。

---

### 4. 中危：`web_accessible_resources` 重复声明

**文件**：`manifest.json`

`images/*` 已覆盖 `images/*.png`。现已仅保留 `images/*`，没有改变实际可访问资源范围。

---

### 5. 中危：Google OAuth 使用 `new Promise(async executor)`

**文件**：`src/background.js`

`startGoogleOAuthSessionInternal` 已改为普通 `async function`；仅 `chrome.identity.launchWebAuthFlow` 回调继续使用 Promise 包装。同步异常、异步 token 交换异常和 Chrome runtime 错误都会进入明确的 reject 路径。

---

### 6. 中危：关键 `importScripts` 错误被静默吞掉

**文件**：`src/background.js`

`product-config.js` 和 `supabase-config.js` 加载失败时现在会输出带文件名的 `console.warn`，避免配置回退后无法定位登录、storage 命名空间或后端地址问题。

---

### 7. 低危：跨产品可信主机回退残留

**文件**：`src/background.js`

正常情况下可信主机来自 `productConfig.allowedHosts`。配置加载异常时，旧回退列表包含 ChatGPT 和 Claude；图片代理也残留 OpenAI、Anthropic 主机和携带凭据的 API 分支。现已：

- 将消息发送方回退主机收敛为 `["gemini.google.com"]`；
- 图片代理仅接受 Gemini 与已声明权限的 Google 图片主机；
- 删除其他产品的图片域名和携带凭据请求分支。

配置失败时保持 fail-closed，不再扩大可信消息发送方范围。

---

### 8. 中危：批量保存结果状态重复

**文件**：`src/content.js`

批量导出结果现在使用每个文件的真实保存结果，不再把保存失败的文件同时列为“已保存”和“失败”。

---

### 9. 中危：选择消息快速再导出丢失范围

**文件**：`src/content.js`

选择导出成功或失败后会保存原消息快照。快速再导出、切换格式和失败重试都使用该快照，不再退出选择模式后误导出整段会话。

---

### 10. 中危：Pro 权益文案与 DOM 顺序耦合

**涉及文件**

- `src/popup.html`
- `src/popup.js`
- `_locales/*/messages.json`

权益项改为通过 `data-benefit-key` 绑定文案，不再依赖数组下标。9 个语言包均统一为 647 个键，并验证所有 `$1/$2` 位置参数一致。

---

### 11. 中危：商店 ZIP 不可复现

**文件**：`scripts/package-extension.mjs`

打包流程现已固定文件顺序、文件时间戳和时区，并移除 ZIP extra fields。同一源码连续打包 SHA-256 完全一致。

---

## 二、非代码事项

### project memory 中的 `clipboardWrite` 说明已过时

`content.js` 已使用 `navigator.clipboard.writeText`，manifest 未声明 `clipboardWrite` 是正确的。该 memory 文件位于项目仓库之外，不影响运行时，也未在本轮修改。

---

## 三、自动化验证

### 完整发布检查

```text
npm run check
npm test
npm run audit
npm run package
```

结果：

```text
tests 49
pass 49
fail 0

found 0 vulnerabilities

Packaged 88 files
ZIP: dist/gemini-export-1.3.0.zip
```

### ZIP 完整性与可复现性

```text
unzip -t: No errors detected

SHA-256（连续两次）：
9d415edb64b57718fec3091025104f62512828717624792a7f4b50436e3412fc
9d415edb64b57718fec3091025104f62512828717624792a7f4b50436e3412fc
```

### Supabase 线上核对与部署

- 本地 9 个 migration 与远端 `supabase_migrations.schema_migrations` 完全一致，无数据库迁移待部署。
- `product-payment-webhook` 已部署为 **v25 / ACTIVE / verify_jwt=false**。
- `payment-webhook` 已部署为 **v33 / ACTIVE / verify_jwt=false**。
- 两个 Webhook 使用 Paddle 签名认证，因此保持 `verify_jwt=false` 是预期配置。
- 部署后分别发送无 Paddle 签名的 POST 烟雾请求，均返回 **401**，未返回 500。
- `product-verify-export-entitlement` 已为 **ACTIVE**，本轮客户端权限协议无需重新部署。

---

## 四、发布前建议的人工冒烟测试

自动化测试已覆盖代码路径和关键安全回归。发布前仍建议在真实 Chrome 中执行以下交互检查：

1. Google OAuth 登录、取消和失败重试。
2. Free 用户第 3/4 次导出的额度边界。
3. Pro 用户正常导出，以及服务器暂时不可达时的近期验证回退。
4. DevTools 写入明文 `{plan: "pro"}` 后确认不能获得 Pro 导出权限。
5. 含信用卡、国际电话、时间戳和长订单号的脱敏导出。
6. 在 Paddle Sandbox 重放一个带已删除/不存在 `user_id` 的有效签名事件，确认 Webhook 不再因审计表外键返回 500。
