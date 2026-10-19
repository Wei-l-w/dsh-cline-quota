# dsh-cline-quota

> 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话页头显示 **Cline / ClinePass 订阅额度**、**Credits 余额**与 **ClinePass token 消耗**，支持**多账号**切换。
>
> A DSH plugin that shows your Cline / ClinePass subscription quota, credits and ClinePass token consumption in the session header — with multi-account switching.

零依赖、无构建步骤：host 半边只用 Node 内置模块，client 半边是手写的模块包（只用到 shell 提供的 `react`）。

## 功能

- **页头 chip**：显示最紧的 5 小时窗口占用百分比，按压力变色（>70% 琥珀、>90% 红）；悬停给出三个窗口 + 余额的一行摘要。多账号时摘要里会带上账号名。
- **弹层**：
  - 5 小时 / 本周 / 本月三个窗口的进度条、百分比与重置倒计时
  - `Credits（按量付费）` 余额
  - `Token 消耗` 块：日期区间选择（含 `24h` / `7 天` / `14 天` / `30 天` 预设）、合计 token 与金额、每日（或每周、24h 下按小时）柱状图、以及**可点选的模型列表** —— 点某个模型即可只看它的消耗
- **多账号**：在面板里直接粘贴 API key 添加账号，`⇄` 循环切换，`✕` 移除
- 只统计 `aiModelTypeName === 'cline-pass'` 的用量，与上面的 ClinePass 额度口径一致

## 安装

已同时发布到 **npm** 与 **GitHub**，两个源内容逐字节一致：

| 来源 | 安装标识 |
|---|---|
| npm（推荐） | `dsh-cline-quota` — https://www.npmjs.com/package/dsh-cline-quota |
| GitHub | `github:Wei-l-w/dsh-cline-quota` |

### 1) 插件面板（推荐）

DSH 侧边栏 →「插件」→「添加插件」，填 `dsh-cline-quota`（或 `github:Wei-l-w/dsh-cline-quota`；也可以填本地目录 / `.tgz` 的**绝对路径**）。

### 2) 命令行

```powershell
dsh plugin --profile <profile> add dsh-cline-quota
```

> 桌面版占用的 `desktop` profile 不能从命令行管理（会报 `profile "desktop" is managed exclusively by the Electron application`）；这种情况请用上面的插件面板。

装完刷新窗口即可看到 chip；**host 半边**的改动需要重启 DSH 才会重新加载。

## 配置账号

默认使用凭据引用 `CLINE_API_KEY`（就是 profile 里 `cline` provider 用的那个名字）。

**方式一：面板里粘贴**（推荐）

账号行右侧 `＋` → 粘贴 key → 保存。插件会先用 `GET /users/me` 验证这个 key，通过后：

- key 写进 DSH 凭据库 `$DSH_HOME/.credentials.yaml`（与现有 `CLINE_API_KEY` 同一处，权限 600）
- 插件自己的名单文件 `$DSH_HOME/cline-quota.accounts.json` 只记 `label` + 引用名，**不存明文**
- 面板自动切到这个新账号；账号名默认取该账号邮箱

**方式二：配置文件**

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: cline-quota
  config:
    accounts:
      - label: 主号
        keyRef: CLINE_API_KEY
      - label: 备号
        keyRef: CLINE_API_KEY_2
```

key 本体放 `$DSH_HOME/.credentials.yaml` 的 `refs:` 下，或 `$DSH_HOME/.env`（只读回退层）。配置改完不必重启（loader 会带新配置重新 `apply`）。

## 关于金额（重要）

- 三个百分比是 **Cline API 给的**（按参考价加权的配额占用），不是本地用 token 数算的。
- `Token 消耗` 块里的 `$` 是 Cline 按它的**参考价**折算的用量价值，**不是账单**：ClinePass 是订阅制，参考价不等于实付金额。
- 对 `cline-pass/deepseek-v4.1-flash`，Cline 的参考价 = DeepSeek 官方**高峰**价（输入 $0.30 / 缓存命中 $0.006 / 输出 $1.20 每百万 token）；DeepSeek 空闲价是它的一半。
- `0.1.0` 把 Cline 的 usage/caps 金额字段当成了 micro-USD，金额会放大 100 倍；`0.2.0` 已修正（usage/caps 按 `1e-8` 折算，`Credits` 余额仍是 micro-USD）。

## 安全与隐私

- API key 只在 host 进程里按**引用名**解析；浏览器只会拿到额度数字、账号邮箱与引用名。
- 面板里粘贴的 key 只在本机 loopback 的 POST body 里出现一次：**不回显、不写日志**（诊断日志只记方法、是否强制刷新、账号名、区间、UA、origin）。
- 插件不做任何遥测；host 进程只直连 `https://api.cline.bot`。
- 路由在本机 loopback 上**无鉴权**（与 DSH 中其它精确路由一致）：同机进程可以读到额度数字与邮箱，但读不到 key。

## 兼容性

- 需要带 `conversation.session.header.utilities` 座位的 DSH；在 **0.2.1-rc.2**（桌面版内置版本）上验证。
- Node >= 22。

## 开发与测试

```bash
npm test
```

`test/accounts.test.mjs` 是离线 harness：把真实的 host 半边挂到假 ctx 与假 Cline API 上，覆盖账号选择、粘贴 key（验证 → 写凭据库 → 名单文件）、重复 key/重名、删除、以及金额单位换算。`test/range-presets.test.mjs` 校验区间预设的高亮映射与"数据已过期"判定（24h / 7 / 14 / 30 天与自定义区间）。

### 发版（维护者）

```bash
npm version patch          # 或 minor / major：改版本号并打 tag
npm publish --access public
git push --follow-tags
```

> 品牌新包的**首次**发布会先进入 npm 的 staged 队列：registry 上先出现 `0.0.0-stage` 占位版，实测约一分钟后自动上架。若被拦下需要 maintainer 用 2FA 批准 —— npm ≥ 11.15 用 `npm stage list` / `npm stage approve <stage-id>`，或在 npmjs.com 的 **Staged Packages** 页点 Approve。

## 卸载

插件面板里卸载，或：

```powershell
dsh plugin --profile <profile> remove dsh-cline-quota
```

## 声明

与 Cline / ClinePass 官方无隶属关系；"Cline" 仅用于说明本插件查询的服务。

## License

MIT © Wei-l-w
