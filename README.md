# GRAM 数字典藏平台

本地运行的全栈平台：Ruby/WEBrick 后端、SQLite 数据库，以及适配手机和桌面的响应式前端（桌面端为交易所风格布局）。包括服务端注册/登录（需邀请码）、账户余额及交易记录、八级铸造池、礼物目录、用户典藏/出租/生息和受权限保护的多模块管理后台。新注册账户初始余额为 0，充值需经后台审核确认后入账。
## 邀请码与代理体系

- 注册必须填写邀请码。每位用户（含管理员）注册后都会获得专属邀请码，格式为 5 位大写字母与数字组合，系统保证唯一，仅用于注册。
- 使用谁的邀请码注册，该用户就计入谁的名下（`invited_by`）。邀请人账户停用后，其邀请码立即失效。
- 主后台可在「代理管理」中添加代理账户；代理拥有自己的后台，但只能访问属于自己名下的用户管理与下单管理（充值提现审核、下注记录），无法访问铸造池规则、礼物目录、操作审计，也不能添加代理或生成用户。
- 主后台可在「生成用户」直接创建用户账户并自动生成邀请码，可指定上级代理；管理员和代理都可以在「用户管理」中重新生成邀请码，旧邀请码随即失效。
- 用户可在平台「个人中心」查看并复制自己的邀请码，分享给他人注册。

## 启动本地系统

需要 Ruby 2.6 或更高版本，以及 `sqlite3` 和 `webrick` Ruby gems。在终端切换到项目目录并运行：

```sh
ruby server.rb
```

然后打开 <http://127.0.0.1:9292/>。普通用户在登录页注册（新账户初始余额为 0，充值需经后台审核确认后入账），注册时需要邀请码；管理后台位于 <http://127.0.0.1:9292/admin.html>，默认管理员账户为用户名 `admin`、密码 `123123123123`，管理员和代理账户均可登录后台，代理登录后只能查看自己名下的用户与订单数据。服务默认仅监听本机回环地址，不要直接改为公网监听。

## 数据库：本地 SQLite 与云端 PostgreSQL

平台通过 `db.rb` 适配层同时支持两种数据库，业务代码无需改动：

| 场景 | 配置 | 说明 |
|---|---|---|
| 本地开发 | 默认，无需配置 | 使用 `data/gram.sqlite3`，可用 `GRAM_DATABASE` 指定路径 |
| 云端部署 | `DATABASE_URL=postgres://用户:密码@主机:5432/库名` | 自动切换 PostgreSQL，schema 自动建表 |

适配层负责占位符转换（`?` → `$1, $2`）、布尔值归一、异常归一（唯一/外键冲突统一为 409）与两种库的 schema 差异（`INTEGER PRIMARY KEY AUTOINCREMENT` ↔ `BIGSERIAL`）。

## 部署到 Supabase（免费，无需信用卡）

平台后端已从「本地 Ruby 服务」迁移为 **Supabase PostgreSQL + Edge Functions**，前端为纯静态文件。两个部分都可以免费用：

- **后端**：Supabase 免费档（500MB 数据库、每月 50 万次函数调用），无需绑卡
- **前端**：静态文件托管到 GitHub Pages 或 Cloudflare Pages（均免费无需绑卡）

迁移后业务逻辑、接口路径、字段名、权限模型与原 Ruby 版完全一致，前端调用点零改动（只改一个配置项）。

### 目录结构

```
supabase/
├── config.toml            # Supabase CLI 项目配置
├── deploy.sh              # 一键部署脚本（迁移 + 函数 + 前端配置）
├── seed-admin.sh          # 创建首个管理员账户
├── migrations/
│   ├── 0001_init.sql      # 10 张表、种子数据、RLS 全表锁定
│   └── 0002_functions.sql # 原子操作函数（下注/结算/审核/调额）
└── functions/
    ├── _shared/           # http / db / auth / business 共享库
    └── api/index.ts       # 全部 33 个接口的路由实现
```

### 安全设计

- 所有表启用 **行级安全（RLS）且不授予任何策略**：浏览器端用 anon/authenticated 密钥**无法直接读写任何表**
- 唯一数据入口是 Edge Function，它以 `service_role` 密钥连接（该密钥只存在于服务端环境变量，不会下发到浏览器）
- 会改余额的复合操作（下注扣款、结算派奖、提现冻结、审核入账、管理员调额）全部下沉为 **Postgres 函数 + `SELECT ... FOR UPDATE` 行锁**，避免并发超额扣注
- 会话令牌只存 SHA-256 哈希；写操作强制校验 CSRF；跨站 Cookie 为 `HttpOnly; SameSite=None; Secure`

### 部署步骤

**1. 安装 CLI 并准备项目**
```sh
npm i -g supabase
supabase login
```
在 <https://supabase.com> 创建项目，记下 Project Settings → General 里的 **Reference ID**。

**2. 一键部署后端**
```sh
cd supabase
./deploy.sh <你的项目Reference ID>
```
脚本会依次：关联项目 → 推送数据库迁移（建表 + 8 个铸造池 + 24 个礼物种子）→ 部署 `api` 函数 → 自动把前端 `supabase-config.js` 指向该项目。

**3. 配置服务端密钥**（Supabase 控制台 → Edge Functions → Secrets）

| 变量 | 值 |
|---|---|
| `SUPABASE_URL` | `https://<项目ID>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API 里的 `service_role` key（**不是** anon key） |

**4. 创建管理员账户**
```sh
SUPABASE_URL=https://<项目ID>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
./supabase/seed-admin.sh admin 'YourStrongPassword123'
```
输出会给出管理员的专属邀请码，用户注册时需要它。

**5. 部署前端**

```sh
git add supabase-config.js index.html admin.html
git commit -m "Point frontend at Supabase"
git push
```
然后把仓库连到 GitHub Pages 或 Cloudflare Pages 即可。前端只负责加载静态文件，所有 `/api` 请求会跨域发送到 Supabase（Edge Function 已开启 CORS，Cookie 已按跨站要求配置）。

### 本地开发

`supabase-config.js` 中 `GRAM_API_BASE` 留空时，前端仍请求同源 `/api`，可继续用 `ruby server.rb` 本地运行（两种后端可随时切换）。

### 数据迁移说明

新库从零开始，不会带上旧 SQLite 里的账户与余额。如需迁移历史数据，可先把 `data/gram.sqlite3` 导出为 CSV，再用 Supabase 控制台的 Table Editor 导入对应表。

## 项目文件

- `index.html`、`styles.css`、`app.js`：平台界面和同源后端 API 交互
- `admin.html`、`admin.css`、`admin.js`：管理后台总览、用户、充提审核、下注风险审核、池规则、礼物目录、典藏记录和审计
- `db.rb`：数据库适配层，统一封装 SQLite 与 PostgreSQL（连接、占位符、事务、异常）
- `server.rb`：Ruby/WEBrick API、会话、业务规则、审计和持久化
- `data/gram.sqlite3`：本机运行时自动创建的 SQLite 数据库（不提交）
- `Gemfile` / `Dockerfile` / `.dockerignore` / `render.yaml` / `.replit`：本地 Ruby 后端、容器镜像与部署配置（保留原方案）
- `supabase/`：Postgres 迁移、Edge Functions 与一键部署脚本（现行 Supabase 方案）
- `supabase-config.js`：前端后端寻址开关（留空走本地 Ruby，填写则指向 Supabase）
- `favicon.svg`：GRAM 网站图标
