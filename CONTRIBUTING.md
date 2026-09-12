# Contributing

提交更改前请运行：

```bash
./scripts/package.sh
python3 scripts/verify-package.py dist/*.qplug
```

新增 capability 时必须同时实现同名 handler；新增主机调用时只申请它所需的
最小权限。不要提交 `dist/`、发布私钥、账号凭据或服务端秘密。
