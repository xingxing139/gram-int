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

## 部署到免费平台（Render + Neon，无需信用卡）

推荐组合：**Render 免费 Web Service 运行容器** + **Neon 免费 PostgreSQL**。全程不需要信用卡。

- Web Service 使用 `free` 计划：512MB 内存，不产生费用；15 分钟无请求会休眠，下次访问需 30–50 秒唤醒
- 数据库使用 Neon 免费库（0.5GB，闲置约 5 分钟自动暂停，唤醒很快），**不依赖** Render 那个 90 天有效期的免费 PostgreSQL
- 仓库提供 `Dockerfile`，Render 用它构建镜像；这一步在免费档同样不收费（与 Hugging Face 的 Docker SDK 付费是两回事）

### 第一步：创建免费数据库（Neon）

1. 打开 <https://neon.tech> 用 GitHub 登录，创建一个 Project
2. 在 Project Dashboard 复制 **Connection string**，形如
   `postgres://user:password@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`
3. 该连接串即稍后要填的 `DATABASE_URL`

### 第二步：Blueprint 部署

1. Render 控制台 <https://dashboard.render.com> → **New → Blueprint**
2. 授权并选择仓库 `xingxing139/gram-int`，Render 读取 `render.yaml` 自动创建服务
3. 进入服务的 **Environment**，手工补充以下变量（`render.yaml` 中它们是注释的，必须自己填）：

   | 变量 | 值 |
   |---|---|
   | `DATABASE_URL` | 第一步的 Neon 连接串 |
   | `GRAM_ADMIN_USERNAME` | `admin` |
   | `GRAM_ADMIN_PASSWORD` | 至少 12 位的强密码 |

   `BIND_ADDRESS` 与 `RACK_ENV` 已在 `render.yaml` 中预设，无需重复设置

4. 保存后 Render 自动重新部署，完成后分配 `https://xxx.onrender.com` 域名，管理后台路径为 `/admin.html`

#### 零成本快速演示（Replit，无需绑卡）

如果只是想先把项目跑起来给别人看，不想配置任何平台，用 Replit 最简单：

1. <https://replit.com> 用 GitHub 登录（免费，不需要信用卡）
2. **Create Repl** → **Import from GitHub** → 填 `https://github.com/xingxing139/gram-int`
3. 直接点 **Run**

仓库里的 `.replit` 已配好 Ruby 环境依赖（含 sqlite 系统库）、启动命令和端口（3000），无需改任何代码。Replit 会自动构建并给出一个公开 URL（形如 `https://gram-int.<你的用户名>.repl.co`），转发给别人即可访问。

演示版使用容器内 SQLite，**Replit 休眠或重建后数据会清空**，仅适合演示；同时 URL 是公开的，建议在 Replit 的 Secrets 里设置 `GRAM_ADMIN_PASSWORD` 覆盖默认管理员密码。

## 注意事项

- **必须设置 `DATABASE_URL`**。容器文件系统是临时的，重启或重新部署后 SQLite 数据会全部丢失。
- **必须覆盖 `GRAM_ADMIN_PASSWORD`**。代码里的默认密码是公开的，不覆盖等于后台敞开。
- 免费实例休眠期间首次访问会等待数十秒，属正常现象；如需常驻可升级到付费实例。

### 也支持其他平台

`Dockerfile` 是通用的，Hugging Face Spaces（需把 `ENV PORT` 改为 7860）、Koyeb、Google Cloud Run 均可直接复用。

### 关于 Supabase 的说明

Supabase 不提供 Ruby 运行环境（仅 PostgreSQL / Auth / 边缘函数），无法直接托管本平台的后端服务，但非常适合作为**数据库层**：把 `DATABASE_URL` 指向 Supabase 免费库的连接串即可。若希望完全迁到 Supabase（含边缘函数重写全部后端逻辑），需要重写约 1500 行业务代码并把权限模型迁移到数据库层，工作量和风险都远大于此方案。

## 项目文件

- `index.html`、`styles.css`、`app.js`：平台界面和同源后端 API 交互
- `admin.html`、`admin.css`、`admin.js`：管理后台总览、用户、充提审核、下注风险审核、池规则、礼物目录、典藏记录和审计
- `db.rb`：数据库适配层，统一封装 SQLite 与 PostgreSQL（连接、占位符、事务、异常）
- `server.rb`：Ruby/WEBrick API、会话、业务规则、审计和持久化
- `data/gram.sqlite3`：本机运行时自动创建的 SQLite 数据库（不提交）
- `Gemfile` / `Dockerfile` / `.dockerignore` / `render.yaml` / `.replit`：依赖声明、容器化镜像与部署配置（Render 生产 / Replit 演示）
- `favicon.svg`：GRAM 网站图标
