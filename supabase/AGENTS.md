# 云端监控后端

- migrations 保存可重复执行的监控 schema 与最小权限；functions/monitor-ingest 保存已认证的上报入口。
- 只部署到 uniagent-monitor（dmflhqruqszbxhozdkek）。不修改同组织其它项目，不保存密钥。
- 匿名安装只可上报；管理员必须由受管名单验证。所有 SQL/RPC 明确 grants、RLS 和 search_path。
- 后端契约由 test/cloud-monitor-database.ts 在 PGlite PostgreSQL 中执行验证，并进入 test:release。
