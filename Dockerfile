# Koyeb / Hugging Face Spaces / Cloud Run 通用镜像
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

# 云平台要求监听所有网卡；端口由平台的 $PORT 注入
ENV BIND_ADDRESS=0.0.0.0
EXPOSE 9292

# WEBrick 以 INFO 级别输出启动日志，便于在平台控制台排查
CMD ["ruby", "server.rb"]
