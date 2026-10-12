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

## 部署到免费平台（Koyeb + Neon，无需信用卡）

推荐组合：**Koyeb 免费 Web Service 运行容器** + **Neon 免费 PostgreSQL**。全程不需要信用卡，无冷启动休眠，推送 GitHub 后可自动部署。

仓库已提供 `Dockerfile` 和 `.dockerignore`，Koyeb 会用它构建镜像（也可用于 Hugging Face Spaces、Cloud Run）。

### 第一步：创建免费数据库（Neon）

1. 打开 <https://neon.tech> 用 GitHub 登录，创建一个 Project
2. 在 Project 的 Dashboard 复制 **Connection string**，形如
   `postgres://user:password@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`
3. 该连接串即稍后要填的 `DATABASE_URL`

免费额度为 0.5GB 存储；闲置 5 分钟后计算实例会自动暂停，下次访问数秒内唤醒，不影响数据。

### 第二步：部署到 Koyeb

1. 打开 <https://app.koyeb.com> 用 GitHub 登录
2. **Create Service** → 选择 GitHub 仓库 `xingxing139/gram-int`
3. Builder 选 **Dockerfile**（会自动识别仓库根目录的 Dockerfile）
4. 配置项：
   - **Port**：`8000`（容器内由 `$PORT` 注入；若平台默认其他端口以控制台为准）
   - **Health check**：路径填 `/api/health`，端口与外网端口一致
   - **Instance**：选 Free 档（256MB 内存 / 0.1 vCPU）
5. **Environment variables** 添加以下变量（Secret 类型会加密存储）：

   | 变量 | 值 |
   |---|---|
   | `DATABASE_URL` | 第一步的 Neon 连接串 |
   | `BIND_ADDRESS` | `0.0.0.0` |
   | `GRAM_ADMIN_USERNAME` | `admin` |
   | `GRAM_ADMIN_PASSWORD` | 至少 12 位的强密码 |

6. 部署完成后 Koyeb 会分配一个 `https://xxx.koyeb.app` 域名，首页与管理后台（`/admin.html`）即可访问

### 注意事项

- **务必设置 `DATABASE_URL`**。免费平台的文件系统是临时的，重启或重新部署后容器内 SQLite 数据会全部丢失。
- 管理员密码必须通过环境变量覆盖代码里的默认值，否则任何拿到仓库的人都能登录后台。
- 若使用 Hugging Face Spaces 代替 Koyeb，需把容器端口改为 `7860`，并在 Space 的 README 顶部添加 Spaces 配置。

### 关于 Supabase 的说明

Supabase 不提供 Ruby 运行环境（仅 PostgreSQL / Auth / 边缘函数），无法直接托管本平台的后端服务，但非常适合作为**数据库层**：把 `DATABASE_URL` 指向 Supabase 免费库的连接串即可。若希望完全迁到 Supabase（含边缘函数重写全部后端逻辑），需要重写约 1500 行业务代码并把权限模型迁移到数据库层，工作量和风险都远大于此方案。

## 项目文件

- `index.html`、`styles.css`、`app.js`：平台界面和同源后端 API 交互
- `admin.html`、`admin.css`、`admin.js`：管理后台总览、用户、充提审核、下注风险审核、池规则、礼物目录、典藏记录和审计
- `db.rb`：数据库适配层，统一封装 SQLite 与 PostgreSQL（连接、占位符、事务、异常）
- `server.rb`：Ruby/WEBrick API、会话、业务规则、审计和持久化
- `data/gram.sqlite3`：本机运行时自动创建的 SQLite 数据库（不提交）
- `Gemfile` / `Dockerfile` / `.dockerignore`：依赖声明与容器化部署配置（Koyeb 等）
- `favicon.svg`：GRAM 网站图标
