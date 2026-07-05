# Mobile:cicy-cloud 登录 + 默认团队(方案)

作者:w-10122(cicy-cloud/SSO owner) · 面向:w-10036(cicy-mobile)
目标:**移动端登录 cicy-cloud 后,直接进入 cicy-cloud 的「默认团队」**;团队逻辑与 **cicy-desktop 完全一致**。

---

## 0. 背景:三种团队(与 desktop 对齐)

| 类别 | 来源 | serverUrl | token / 鉴权 | 说明 |
|---|---|---|---|---|
| **默认团队** | cicy-cloud 内置 | `https://cicy-ai.com` | **session `sk-sess-`** | 登录即有,7 个 cicy-agent 角色,服务端首次 `/api/panes` 懒播种;无 shell/skills |
| **cloud 团队** | `GET /api/teams` kind=cloud/private | `cicy-ai.com`(或 host_url) | session | 用户在云端的团队 |
| **custom(自己扫的)** | QR 扫码 / `/api/teams` kind=custom | 节点 `host_url` | 扫码带的 token | **就是 mobile 现在的加团队方式,基本不动** |

关键点:mobile 现在「(serverUrl, token) 一对 = 一个团队」的抽象**天然就能容纳云端团队** —— 云团队不过是 `serverUrl=cicy-ai.com`、`token=session` 的一个 team。所以工作量集中在「加一个云登录 + 登录后自动放一个默认团队进抽屉」。

---

## 1. 后端:零改动 ✅(w-10122 已验证)

cicy-cloud 已具备 mobile 需要的**全部**端点,且 `authM` 同时接受 session(`sk-sess-`)与 tokens 表 key:

- 登录:`POST /api/auth/email/request`、`GET /api/auth/desktop/poll`
- 团队:`GET /api/teams`、`POST /api/teams`、`PATCH/DELETE /api/teams/:id`
- 工作台:`GET /api/poll`、`GET /api/panes`(**首次访问懒播种 7 个 cicy 角色**)
- 聊天历史(mobile HTTP 轮询用):`/api/agents/current-history/{pane}`、`/api/agents/current-reply/{pane}`、`/api/agents/history-ids/{pane}`(云端以带尾斜杠前缀注册,mobile 的 `/{paneId}` 正好命中)
- 实时:`/api/chat/ws`(认 session);打断:`/api/cicy/cancel`;设备:`/api/device/register`
- 余额:`GET /api/balance`

> 所以 mobile 只要把 **session 当 Bearer 打 `cicy-ai.com`**,现有 `src/api/http.ts` 一行不改就能跑通默认团队。

---

## 2. 登录流程:email magic-link 设备轮询(照搬 desktop `auth-email.js`)

desktop 参照实现:`cicy-desktop/src/backends/auth-email.js`。移动端复制其逻辑(无需 loopback/浏览器回调,适配手机):

```
1. 用户输入 email
2. state = 高熵随机(expo-crypto getRandomBytesAsync → hex64)
3. POST https://cicy-ai.com/api/auth/email/request
     body: { email, state, flow: "desktop_poll" }
4. 提示「已发送登录邮件,请在任意设备点开链接」
5. 轮询 GET https://cicy-ai.com/api/auth/desktop/poll?state=<state>  每 2500ms
     status: "pending" → 继续;"ready" → 拿到 { token: sk-sess-…, accessToken, userId, email };"expired" → 报错重来
   超时 600s
6. 存 session(见 §4),登录完成
7.(可选,与 desktop 一致)POST /api/device/register { deviceId, platform:"mobile", ... }
```

新文件:`src/api/cloud-auth.ts`(emailRequest / pollSession / 常量 `CLOUD_BASE="https://cicy-ai.com"`)。
新屏:`app/login.tsx`(email 输入 → 轮询态 → 成功回首页)。

---

## 3. 登录后:合成默认团队 + 拉团队列表

```
登录成功后:
A) 合成默认团队并选中:
   addTeam({
     serverUrl: "https://cicy-ai.com",
     token: <session>,
     title: t("team.default"),   // 「默认团队」
     kind: "cloud",
     builtin: true,              // 置顶、不可删
   })
   switchTeam(该 team)
   → 进 agents 屏,http.ts 用 Bearer session 打 /api/poll+/api/panes,
     服务端懒播种 7 个 cicy 角色,直接可聊。

B) 拉云端团队合并进抽屉:
   GET https://cicy-ai.com/api/teams  (Authorization: Bearer <session>)
   对每个返回项:
     - kind=cloud/private → serverUrl=cicy-ai.com(或其 workspace_url/host_url), token=session
     - kind=custom        → serverUrl=host_url;apiKey 为空时该 team 只读/标「需扫码补 token」
   按 (serverUrl 归一) dedup 合并进现有 teams,别覆盖用户扫的 custom。
```

---

## 4. 存储 & 类型改动(`src/store/auth.ts` / `storage.ts`)

- 新增 session 持久化:secure-store 新 key `cicy_session`(+ `cicy_user_email`、`cicy_user_id`)。与现有 per-team `cicy_teams_v1` 并存。
- `Team` 类型加:
  - `kind: "cloud" | "custom"`(默认 custom,兼容旧数据)
  - `builtin?: boolean`(默认团队,抽屉置顶且禁删)
- 登出:清 `cicy_session` + 移除 builtin/cloud 团队,保留用户扫的 custom。

---

## 5. custom(扫码)基本不动 + 可选上云同步

- 现有 QR 扫码加 custom 团队流程**保持原样**(`app/scan.tsx` / `parsePayload.ts`,serverUrl=host_url + token)。
- 可选(与 desktop `syncNameToCloud` 一致):**已云登录时**,扫码加成后 `POST /api/teams {title, kind:"custom", host_url}` 同步上云,存回 `cloud_team_id`,实现跨设备。dedup 云端按 (owner, host_url)。非必须,可二期。

---

## 6. 抽屉 UI(`TeamDrawer.tsx`)

分组显示,顺序:
1. **默认团队**(builtin,置顶,不可删)
2. **云团队**(kind=cloud/private)
3. **我扫的**(kind=custom)
未登录时:只显示「登录 cicy-cloud」入口 + 已扫的 custom(保持今天的行为)。

---

## 7. 验收标准

1. 全新装 → 输入 email → 任意设备点邮件链接 → app 轮询到 session,自动进「默认团队」。
2. 默认团队 agents 屏列出 7 个 cicy 角色(服务端懒播种),点进去能聊(HTTP 历史轮询 + 发送 + 打断都对)。
3. 抽屉能看到并切换:默认团队 / 云团队 / 我扫的 custom。
4. 扫码加 custom 团队仍照旧可用。
5. 登出后 session 清除,custom 团队仍在。
6. 后端零改动(全部命中现成 `cicy-ai.com` 端点)。

## 8. 实现前需实机确认的点(非阻塞)
- mobile 的 `/api/poll` 结果解析对「租户默认团队」的 pane 形状是否吻合(角色过滤 role=="master" 等);首访要先打一次 `/api/panes` 触发播种。
- `flow:"desktop_poll"` 复用没问题(poll 端点按 state 检索,与设备无关);如需区分来源可后续加 `flow:"mobile_poll"`,但当前不必。

---

参照实现路径:
- desktop 登录:`cicy-desktop/src/backends/auth-email.js`
- desktop 团队/默认团队/自定义:`cicy-desktop/workers/render/src/App.jsx`、`src/backends/local-teams.js`、`src/cloud/cloud-client.js`
- cloud 端点:`cicy-cloud/api/mgr/main.go`(路由)、`middleware.go`(authM 认 session)
