# monitor-ingest

- index.ts 为 Deno 部署入口，handler.ts 为可执行测试覆盖的 HTTP 处理器。
- 只接受版本化、白名单、有限大小的事件。错误响应不回传底层凭据或 SQL 细节。
