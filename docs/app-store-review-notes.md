# App Store 上架审核注意

CiCy Mobile 在 Apple 视角下属于「远程命令执行 + 远程 AI 代码生成 + BYO backend」三个高风险叠加。
和 Termius / Blink Shell / Working Copy / Pythonista 同类——**只要定位写清楚 + 合规件齐全就能过审**。

按风险高低整理：

---

## 1. 头号红线：Guideline 4.7 / 2.5.2 — 远程代码执行

**风险点**：app 让用户的后端 agent 自动改代码、跑 shell。如果商店描述写成「AI 自动写代码并执行」，
审核员会怀疑 app 本身在执行未审核代码。

**做法**：

- 定位写成 **"a remote control client for your own self-hosted dev server"**——类比 SSH client / Termius。
- 强调 app **本身没有运行任何代码**，只是收发消息显示给 worker。
- 不要描述里写「AI agent 自动操作你的电脑」这种含糊字眼。
- iOS 端**绝对不要**做任何动态加载 JS/native module（Expo Updates / CodePush 灰色，建议禁用 OTA，
  或只推 UI 文案不推业务逻辑）。

---

## 2. Guideline 4.1 + 1.1 — AI 生成内容

iOS 17+ 加了对生成式 AI 的强制要求：

- 必须有 **abuse reporting**（举报按钮，每条 AI 输出能举报）。
- 必须能 **block user / block backend**（drawer 里 "Remove team" 已算半个）。
- AI 输出要有 disclaimer（"AI may produce inaccurate output"）。
- 必须能 **stop generation**（mid-stream 中断）——mobile 现在可能没做，**要补**。
- 如果聊天里能放图片，必须有图片内容过滤；child safety 红线务必避开。

---

## 3. Guideline 5.1 — 隐私合规

必须文件：

- **Privacy Policy URL**（hosted，能公开访问，不能是 markdown 文件）。
- **App Privacy "营养标签"**：实事求是填，token 是 *User Content / Other*，不收集 PII 就勾 *Not Collected*。
- `Info.plist` 任何用到的 permission 给清晰 usage description（相机扫 QR 已经有了）。

---

## 4. Guideline 3.1.1 — 支付

最安全：app 内**不**提任何「购买」字眼，不引导用户付费。

- 不要 in-app 链接到 Stripe / PayPal / 充值页。
- 后端 API 是用户自有，不是 Apple 视野内的 service，所以不触发 IAP 强制。
- 如果未来要卖订阅 / agent credit，**必须**走 IAP，30% 抽成。

---

## 5. Guideline 5.1.4 + 4.8 — 登录

当前 mobile 用 QR token auth，不算 "social login"，**不必加 Sign in with Apple**。但：

- token 输入页面要明确写 "This token is only used to authenticate to your own server"。
- 不要默认填示例 server URL。

---

## 6. 加密合规

`Info.plist` 加：

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

（HTTPS / WSS 用标准 TLS 算 exempt。）

---

## 7. 给审核员的"演示通路"

审核员在自己的 sandbox 设备上跑 app，**必须**能 demo 出主流程：

- App Store Connect 提交时填 **Demo Account** 字段：给个测试 backend URL + token。
- 录一个 30s 视频：扫 QR → 看 agents → 点一个 worker → 发消息 → 收回复。
- "Notes for reviewer" 写清楚：

  > This app connects to user-hosted backends. The demo backend URL/token above
  > shows the full flow. If the demo URL is offline, please contact support@...

---

## 8. App 类别选择

- 选 **Developer Tools**。
- 不要选 *Social Networking*（UGC 红线高）。
- 不要在描述里把 "AI" 当主标题（"AI" 当形容词没问题，但当主标题会被推到 AI 审核流程触发额外要求）。

---

## 9. 容易被打回的文案陷阱

description / screenshot 里 **不要**出现：

- "Hack" / "Crack" / 越狱相关。
- "Run any code" / "Execute commands"（改成 "Send messages to your worker"）。
- "Remote control your computer"（改成 "Stay connected with your dev server"）。
- 任何 Apple 商标 / 第三方 LLM 品牌（"GPT" / "Claude" / "Gemini" 不能当标题）。

---

## 10. 提交前自查清单

- [ ] Privacy Policy URL（建议 `https://cicy-ai.com/privacy`）。
- [ ] Support URL。
- [ ] App Privacy 标签填了。
- [ ] `ITSAppUsesNonExemptEncryption=false`。
- [ ] 有 Report / Block 入口。
- [ ] AI 输出可中断（streaming stop）。
- [ ] 不含 IAP，也不引导外部支付。
- [ ] Demo backend URL + token 给审核员。
- [ ] 录制 review 视频。
- [ ] App 名不含 "AI Agent" / "GPT" / "Claude" 这种第三方品牌词。
- [ ] Bundle ID 用 `com.cicyai.mobile` 这种，避免敏感词。
- [ ] 截图不显示其他 app 截图、Apple logo、敏感操作。

---

## 常见退回理由（不算红线）

第一次提交大概率会被退一两次，常见理由：

- **Guideline 2.1 Information Needed**：要求补 demo account。
- **Guideline 5.1.1**：privacy 描述不全。

回邮件补充就过，不要慌。

---

## 参考

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Generative AI Guidelines (4.1)](https://developer.apple.com/app-store/review/guidelines/#design)
