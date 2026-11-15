# 离线 tokenizer 资源

`deepseek-v4/` 保存官方 tokenizer.json、tokenizer_config.json 和带来源、hash 的 manifest.json。文件用于 Router 描述计数，由后台 worker 读取；不包含模型权重或凭证。更新资产须核对官方来源并执行 JS 与官方编码一致性测试，打包时显式复制整个模型资产目录。
