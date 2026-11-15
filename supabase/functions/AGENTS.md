# 监控函数

- monitor-ingest 校验用户 JWT 后调用限额与入库事务；不信任请求传入的 owner_id。
- 管理密钥只从 Supabase 服务端环境读取，日志中不打印请求体、headers 或认证响应。
