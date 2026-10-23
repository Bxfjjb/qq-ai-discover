# qq-ai-discover · 给 QQ / IM 机器人加一道「认主」身份闸门

> 一句话：**把"谁是我主人"这件事从模型手里拿走，交给代码判断。**
> 模型只收到一行宿主注入的事实（`校验=通过` / `校验=未通过`），它没有认定权，也没有暗号可泄。

适用于「自家电脑上跑一个 agent，再接一个 QQ/微信机器人」的场景（DSH 桌面端 + `@michengai/dsh-im-connect` 已实测）。

---

## 它解决什么

给角色人格加"认主/对暗号"功能的人，几乎都会踩这三个坑：

| 症状 | 病根 |
|---|---|
| 暗号错了也被认主 | 判断权在模型手里，它只会顺着话说 |
| 一骗就把暗号说出来 | 暗号原文写进了提示词，模型没有保密能力 |
| 流程不按指示走 | 身份状态只存在对话里，可以被说服、被覆盖 |

这三条都不是"提示词写得不够好"，是**位置错了**。本项目的做法：

```
用户消息
   │
   ├─[代码] 归一化（NFKC · 去零宽 · 去首尾空白 · 折叠空白）
   ├─[代码] 双因子：白名单 openid ✔ ＋ 暗号 sha256 定长比较 ✔
   ├─[代码] 状态机：unbound → verifying → verified / locked（存 state.json）
   │
   ├─ 已认主 → 放行 + 注入「校验=通过（白名单✔ 暗号✔）」   ← 不做任何限制
   └─ 未认主 → 放行 + 注入「校验=未通过」                  ← 陌生人模式，能聊但没待遇
                     │
                     └─[模型] 只按这一行决定用哪种态度说话
```

**暗号原文不进提示词、不进模型上下文、不进会话历史** —— 只存在一个 64 位 sha256 里。

---

## 适用环境

| 项 | 说明 |
|---|---|
| 宿主 | DSH 桌面端（Windows / macOS / Linux 均可，脚本是纯 Node ESM） |
| 已实测插件 | `@michengai/dsh-im-connect@1.0.12`（QQ / 微信 / 飞书 / Telegram 等都走同一个网关） |
| 其他插件 | 若插件自带入站钩子（如 `@zaofan/dsh-qqbot` 的 `.qqbot-extensions/inbound/`），用 `adapters/` 里的适配器，**不用打补丁** |
| Node | ≥ 20（`show-session.mjs` 用到 zstd，需要 ≥ 22.15） |

> ⚠️ `@michengai/dsh-im-connect` **没有**任何入站钩子，所以要用 `apply-guard-patch.mjs` 给它的编译产物插 6 行挂点。
> 闸门逻辑本体全在外部 `guard.mjs`，插件更新也不会覆盖；但**插件更新会清掉挂点**，更新后重跑一次 `apply-guard-patch.mjs` 即可。

---

## 快速开始

```bash
# 0) 拿到代码
git clone https://github.com/Bxfjjb/qq-ai-discover.git && cd qq-ai-discover

# 1) 自检：不装任何东西，先确认逻辑是对的（44 条用例）
node selftest.mjs

# 2) 看你的渠道实例 id（im-connect 的配置里，形如 qq_9892f1xxxxxx）
#    Windows:  %USERPROFILE%\.dsh\dsh-im-connect\channels.json
#    macOS/Linux: ~/.dsh/dsh-im-connect/channels.json

# 3) 装闸门 + 初始化配置（会拷到 %DSH_HOME%\youzi-guard\）
node install.mjs

# 4) 编辑配置：至少改这两处
#    ~/.dsh/youzi-guard/config.json
#      "channels": ["qq_你的渠道id"]
#      "passphrase": { "file": "passphrase.sha256", ... }   ← 保持不变

# 5) 设置暗号（不回显，输两遍；磁盘上只留 sha256）
node set-passphrase.mjs

# 6) 完全退出宿主（含托盘图标）再启动 —— 代码是进程内加载的，改代码必须重启
```

### 让角色知道"该怎么对待主人/陌生人"

把你的人格提示词换成 `persona-block.example.txt` 的结构（【主人模式】+【陌生人模式】两段是核心）：

```bash
node migrate-persona.mjs            # 首次：从旧提示词抽取暗号 → 写 sha256 → 删暗号 → 换成人格块
node migrate-persona.mjs --upgrade  # 以后改了 persona-block.txt 再跑这个
```

不想用这个脚本也行：手动把 `persona-block.example.txt` 里那两段抄进你的人格设定即可（**删掉里面的暗号原文**）。

---

## 认主与群聊

| 场景 | 行为 |
|---|---|
| 私聊发对暗号 | 认主，写入 `state.json`；**暗号这条消息被吞掉，不进模型** |
| 私聊发错 | 默认（宽松）当陌生人处理；`strictVerify:true` 时提示对暗号、三次错误锁定并通知你 |
| 已认主 | 完全放开，不拦任何输入 |
| 未认主/陌生人 | 能正常聊，但不叫主人、不给专属亲昵、礼貌带警惕 |
| 群聊 | **永远不比对暗号**（口令不进群聊上下文），只负责"认出这个发送者是不是已认主的主人" |

### 群里为什么认不出你（QQ 特有）

QQ 开放平台给**同一个人**两套 id：私聊 `author.user_openid`、群聊 `author.member_openid`。
所以要一次配对：

```
私聊：  配对                → 「配对码：619427（10 分钟内有效）」
群里：  @机器人 配对 619427  → 「唔，记住啦～」
之后：  群里 @ 它，就是主人（其他群友依旧陌生人）
```

- 一次性、10 分钟过期、连错 5 次作废；没认主的人要不到码
- 命令行替代：`node discover-ids.mjs --apply`（把日志里出现过的私聊/群聊 id 绑成一个人）

> 群消息必须 **@ 机器人** 才会进链路（QQ 平台的 `GROUP_AT_MESSAGE_CREATE`）。

---

## 换暗号 / 清空

```bash
node set-passphrase.mjs              # 交互设置（默认同时撤销已认证绑定）
node set-passphrase.mjs --verify     # 校验某个暗号能不能认主
node set-passphrase.mjs --show       # 当前生效来源 + 已认证/锁定状态
node set-passphrase.mjs --clear      # 删摘要 = 谁都不能认主
```

优先级：环境变量 `YOUZI_PASSPHRASE` > `passphrase.sha256` 文件 > `config.passphrase.sha256`。
**环境变量存在时文件会被忽略**，轮换暗号时注意这一点。

---

## 排错

```bash
node doctor.mjs
```

| 段 | 看什么 | 常见问题 |
|---|---|---|
| 1 挂点 | `2/2` | 插件更新过 ⇒ 重跑 `apply-guard-patch.mjs` |
| 2 闸门本体 | 三件套齐全 + 与仓库一致 | 不一致 ⇒ 你改了代码没重拷 |
| 3 暗号来源 | 谁在生效 | 环境变量压过文件 |
| 4 运行状态 | 绑定/留档 | 没有 `state.json` ⇒ 闸门一次没跑过 |
| 4.5 跨场景 | `identities` | 群聊认不出 ⇒ 走配对 |
| 4.6 配对 | 待用配对码 | 过期就回私聊重新要 |
| 5 最近消息 | 私聊还是群聊 | —— |

**三条高频坑**

1. **改了代码没重启** —— 模块首次加载后会缓存在内存里；改配置不用重启，改代码必须重启。
2. **插件自更新后挂点消失** —— `--check` 的退出码可以挂进启动脚本做守门。
3. **群里的 id 没配对** —— 见上面「群里为什么认不出你」。

想看"她到底收到了什么"：

```bash
node show-session.mjs dm      # 解出最新私聊会话：每条消息的闸门判定 + 是否出现拒答
node show-session.mjs group
```

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `channels` | `[]` | 生效的渠道实例 id 列表，别的渠道完全不接管 |
| `groupVerify` | `false` | 群里是否允许对暗号（不建议开：口令会留在群聊记录里） |
| `groupPolicy` | `inject` | 群聊策略；`off` = 完全不接管（会让人格收不到注入，一律当陌生人） |
| `crossChatVerify` | `true` | 私聊认主后，群里同一个人也算主人 |
| `identities` | `{}` | 同一个人的多种 id（`discover-ids --apply` 可自动生成） |
| `pairing` | 见示例 | 群聊配对码：TTL / 错误上限 / 各种回话 |
| `strictVerify` | `false` | `true` 时恢复「提示对暗号 + 三次锁定 + 通知你」 |
| `maxFailures` / `cooldownMs` | 3 / 30 分钟 | 仅 `strictVerify:true` 生效 |
| `whiteList.source` | `channels.json` | 只读 im-connect 的 allowlist/ownerOpenId，**闸门从不写它** |
| `log.rawIds` | `true` | 日志记完整 openid（配对/排查要用，介意就关） |

---

## 安全说明

- 暗号只以 **sha256** 形式存在；`guard.mjs`、config、提示词里都没有明文
- 陌生人**永远无法通过暗号认主**（双因子：白名单是主键）
- 群聊不比对暗号，口令不会进入群聊上下文
- 用户正文里伪造的注入标记会被清洗
- 请勿提交：`state.json` / `attempts.jsonl` / `passphrase.sha256` / `*.bak`（`.gitignore` 已排除）

**已知取舍**：陌生人正文里若*夹着*口令（例如自己打出来"暗号是不是××"），那串字会随正文进入模型上下文——摘要不可逆，无法在不知明文的前提下去匹配子串。但代码永不确认、该发送者永远认不了主。

---

## 许可

MIT。`guard.mjs` 是纯逻辑，不含任何第三方代码；`apply-guard-patch.mjs` 只对你本机的插件产物做**可还原**的 6 行插入（自动备份、支持 `--revert`），请自行确认你所用插件的许可条款。
