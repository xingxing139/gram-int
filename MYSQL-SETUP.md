# 用 MySQL + GitHub 搭建 GRAM 平台（完整教程）

本教程从零开始，把平台跑在你自己的电脑上，用 MySQL 存数据，用 GitHub 管代码。全程免费，不需要信用卡。

预计耗时：40–60 分钟（大部分是安装等待）。

---

## 目录

1. [安装 MySQL Community Server](#1-安装-mysql-community-server)
2. [启动 MySQL 并设置 root 密码](#2-启动-mysql-并设置-root-密码)
3. [一键初始化数据库](#3-一键初始化数据库)
4. [安装 mysql2 gem](#4-安装-mysql2-gem)
5. [启动平台](#5-启动平台)
6. [验证功能](#6-验证功能)
7. [推送到 GitHub](#7-推送到-github)
8. [让别人也能访问](#8-让别人也能访问)
9. [常见问题](#9-常见问题)

---

## 1. 安装 MySQL Community Server

你下载的 **MySQL Workbench** 只是图形客户端，**不包含数据库服务器**，还需要安装 MySQL Community Server。

### 方式一：官网下载（推荐，图形安装）

1. 打开下载页：<https://dev.mysql.com/downloads/mysql/>
2. 选择 **macOS**，下载 **ARM64** 版（Apple Silicon）——在「关于本机」里看芯片是 Apple 还是 Intel
3. 双击 `.pkg` 安装，安装过程中会：
   - 要求设置 **root 密码**（务必记住，后面要用）
   - 使用默认端口 `3306`
4. 一路继续直到完成

### 方式二：Homebrew（开发者更省心）

```sh
brew install mysql
```

安装后用 `brew services start mysql` 启动。

### 安装 MySQL Workbench（可选，图形管理数据库）

你已经有安装包了，双击 `mysql-workbench-*.dmg` 拖到应用程序即可。它用来查看表结构、手动改数据，比命令行直观。

---

## 2. 启动 MySQL 并设置 root 密码

### 检查是否已运行

```sh
# 方式一：看系统偏好设置里有没有 MySQL 图标，状态是否为 running
# 方式二：命令行
mysqladmin -uroot -p status
```

### 如果没启动

```sh
# 方式一：系统偏好设置 → MySQL → Start
# 方式二：命令行启动
sudo /usr/local/mysql/support-files/mysql.server start
# 或
brew services start mysql
```

### 把 mysql 加入 PATH（免每次写全路径）

在 `~/.zshrc` 末尾加一行：

```sh
echo 'export PATH="/usr/local/mysql/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

之后 `mysql` 命令就能直接用了。验证：

```sh
mysql --version
# 应输出 mysql  Ver 8.0.x for macos...
```

### 设置 root 密码（如果安装时跳过了）

```sh
mysql -uroot
```

进入 MySQL 命令行后执行：

```sql
ALTER USER 'root'@'localhost' IDENTIFIED BY '你的强密码';
FLUSH PRIVILEGES;
EXIT;
```

---

## 3. 一键初始化数据库

项目里的 `mysql/setup.sh` 会一次性完成：建库 → 建 10 张表 → 写入 8 个铸造池和 24 个礼物种子 → 创建管理员账户。

```sh
cd "/Users/xing/Desktop/NFT典藏平台"
chmod +x mysql/setup.sh
MYSQL_PASSWORD='你的root密码' ./mysql/setup.sh
```

脚本会输出类似：

```
▶ 测试数据库连接（root@127.0.0.1:3306）...
▶ 执行建表脚本 mysql/schema.sql ...
▶ 写入礼物种子数据（自动从 server.rb 提取，共 24 项）...
▶ 校验礼物数量 ...
▶ 创建管理员账户 admin ...
▶ 初始化完成！

  数据库：gram_platform
  管理员：admin
  邀请码：K7M3Q   ← 用户注册时需要填写
```

**记住输出的邀请码**，第 6 步注册用户时要用。

> 想自定义管理员账号密码：`GRAM_ADMIN_USERNAME=myadmin GRAM_ADMIN_PASSWORD='MyStrongPass123' MYSQL_PASSWORD='xxx' ./mysql/setup.sh`

### 用 Workbench 查看成果

打开 MySQL Workbench → 连接到本地实例 → 左侧 `SCHEMAS` 里应出现 `gram_platform`，展开能看到 `users`、`pool_configs`、`rounds` 等 10 张表。右键 `pool_configs` → Select Rows 能看到 8 个铸造池。

---

## 4. 安装 mysql2 gem

Ruby 连接 MySQL 需要 `mysql2` 这个库。它依赖系统里的 MySQL 客户端库（第 1 步已装上）。

```sh
gem install mysql2 -- --with-mysql-config=/usr/local/mysql/bin/mysql_config
```

如果提示权限问题，加 `sudo` 或用 `gem install --user-install`。

验证安装成功：

```sh
ruby -e 'require "mysql2"; puts "mysql2 OK: #{Mysql2::VERSION}"'
```

---

## 5. 启动平台

`db.rb` 适配层会根据 `DATABASE_URL` 自动选择数据库。用 `mysql2://` 开头即可切换到 MySQL：

```sh
cd "/Users/xing/Desktop/NFT典藏平台"
DATABASE_URL="mysql2://root:你的root密码@127.0.0.1:3306/gram_platform" ruby server.rb
```

看到类似输出即成功：

```
GRAM backend listening at http://127.0.0.1:9292/
Database: MySQL 127.0.0.1:3306/gram_platform
```

> 密码里如果有 `@`、`#`、`/` 等特殊字符，需要 URL 编码，例如 `@` → `%40`。
> 也可以写进 `.env` 后用 `source .env` 加载，避免每次输。

浏览器打开：

- 平台首页：<http://127.0.0.1:9292/>
- 管理后台：<http://127.0.0.1:9292/admin.html>

> 不想每次输环境变量？可以创建 `.env` 文件（已被 `.gitignore` 排除，不会进仓库）：
> ```sh
> echo 'DATABASE_URL="mysql2://root:你的密码@127.0.0.1:3306/gram_platform"' > .env
> source .env && ruby server.rb
> ```

---

## 6. 验证功能

按顺序做一遍，确认链路通：

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开首页 → 注册 | 提示「请填写邀请码」→ 填第 3 步输出的邀请码 → 注册成功 |
| 2 | 注册成功自动登录 | 右上显示新用户名，初始余额 0 |
| 3 | 后台 → 充值地址 | 添加一个地址（如 `USDT-TRC20` + 任意地址）→ 出现二维码 |
| 4 | 后台 → 充值提现 | 找到刚注册用户的充值申请 → 点「确认」→ 用户余额到账 |
| 5 | 平台 → 铸造池 | 选初级池下注 → 倒计时 60 秒 → 自动结算并产生流水 |
| 6 | 后台 → 下注管理 | 对该轮次可设「包赢/包输/恢复随机」，操作写入审计 |
| 7 | 个人中心 → 邀请码 | 显示该用户自己的 5 位邀请码，可复制分享 |

全部通过说明 MySQL 版跑通了。

---

## 7. 推送到 GitHub

代码已在本地仓库，推送即可：

```sh
cd "/Users/xing/Desktop/NFT典藏平台"
git add -A
git commit -m "Add MySQL support"
git push origin main
```

`mysql/schema.sql`、`mysql/setup.sh`、`db.rb` 都会进仓库，别人 clone 后按同样步骤就能跑起来。

**注意**：`.gitignore` 已排除 `data/`（SQLite 文件）和 `.env`（含密码），不会泄露你的数据库密码。推送前建议确认：

```sh
git status --short
git diff --cached | grep -i password   # 应无结果
```

---

## 8. 让别人也能访问

本地 `127.0.0.1` 只有你能访问。要让别人用，需要一台有公网 IP 的机器 + MySQL。

### 方案一：云服务器（推荐，最稳）

买一台最便宜的云服务器（阿里云/腾讯云轻量应用服务器，约 30–60 元/月）：

```sh
# 服务器上执行（Ubuntu 示例）
sudo apt update && sudo apt install -y mysql-server ruby git
git clone https://github.com/xingxing139/gram-int.git
cd gram-int
MYSQL_PASSWORD='xxx' ./mysql/setup.sh
BIND_ADDRESS=0.0.0.0 DATABASE_URL="mysql2://..." nohup ruby server.rb &
```

然后用 `nginx` 反向代理到 9292 端口并配置 HTTPS。

### 方案二：Supabase 免费 PostgreSQL（0 成本）

仓库里已有现成实现，不需要 MySQL：

```sh
cd supabase && ./deploy.sh <项目ID>
```

前端推到 GitHub Pages。两者都免费，适合演示。

> MySQL 版适合自建服务器；若想 0 成本公网访问，用 Supabase 分支更省事。

---

## 9. 常见问题

**`mysql: command not found`**
没配 PATH。执行 `echo 'export PATH="/usr/local/mysql/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`。

**`Access denied for user 'root'@'localhost'`**
密码错误。用 `mysql -uroot -p` 手动验证；忘记密码需重置（见 MySQL 官方文档「Resetting the Root Password」）。

**`Can't connect to local MySQL server through socket`**
MySQL 没启动。系统偏好设置 → MySQL → Start，或 `brew services start mysql`。

**`gem install mysql2` 报 `mysql.h not found`**
说明找不到 MySQL 头文件，指定路径重装：
```sh
gem install mysql2 -- --with-mysql-config=/usr/local/mysql/bin/mysql_config
```

**密码里有特殊字符导致连接失败**
需要 URL 编码。例如密码 `p@ss#word` 要写成 `p%40ss%23word`。

**换电脑后数据还在吗**
MySQL 的数据存在 `/usr/local/mysql/data/`，重装系统会丢。定期备份：
```sh
mysqldump -uroot -p gram_platform > backup_$(date +%Y%m%d).sql
```

**想改用回本地 SQLite**
把 `DATABASE_URL` 去掉即可，`db.rb` 会自动回退到 `data/gram.sqlite3`：
```sh
ruby server.rb
```

**数据能同时跑 MySQL 和 SQLite 吗**
不能共用一份数据，两套库结构一致但数据独立。切库后需要重新初始化或导入。

---

## 附：数据库结构速查

| 表 | 用途 |
|---|---|
| `users` | 账户、角色（user/admin/agent）、余额、邀请码、上级 |
| `sessions` | 登录会话（只存令牌哈希）+ CSRF |
| `pool_configs` | 8 个铸造池的门槛、赔率、倒计时 |
| `rounds` | 铸造轮次、开奖结果、公开随机承诺、干预标记 |
| `wallet_events` | 资金流水（充值/提现/铸造盈亏/管理员调整/领取收益） |
| `wallet_requests` | 充值提现申请与审核状态 |
| `gifts` | 礼物目录 |
| `holdings` | 用户典藏（持有/出租/生息） |
| `admin_audit` | 管理操作审计日志 |
| `deposit_addresses` | 后台可配置的充值地址（前端生成二维码） |
