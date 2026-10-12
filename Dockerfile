# 容器镜像：Render / Koyeb / Cloud Run / Hugging Face Spaces 通用
# Ruby 3.x + PostgreSQL 驱动；默认以 SQLite 运行，设置 DATABASE_URL 即切换 PostgreSQL
FROM ruby:3.2-slim

# libpq-dev 供 pg gem 编译；build-essential 供原生扩展
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖再拷贝代码，利用镜像层缓存
COPY Gemfile ./
RUN bundle install --jobs 4 --retry 3

COPY . .

# 云平台要求监听所有网卡。
# 默认端口 7860：Render 等平台按容器 EXPOSE 端口路由；Koyeb / Cloud Run 会在
# 运行时注入自己的 $PORT，其优先级高于此处的 ENV，无需改动即可通用。
ENV BIND_ADDRESS=0.0.0.0
ENV PORT=7860
EXPOSE 7860

# WEBrick 以 INFO 级别输出启动日志，便于在平台控制台排查
CMD ["ruby", "server.rb"]

