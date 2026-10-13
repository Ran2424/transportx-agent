# Web 白名单登录与域名部署

Web 运行时不需要 Electron。分别执行 `npm run build:server`、`npm run build:web`、`npm run build:react`，再以专用用户启动 `node bin/tau.js`。

设置 `TAU_WEB_USERS_FILE=/etc/transportx/web-users.json` 即启用白名单登录，强制保护 HTTP API 和 WebSocket；不设置时保留已有本地/桌面认证行为。工作台、任务、模型配置和历史对话由所有授权用户共享，无公开注册入口。

## 账号管理

在服务器的 `/opt/transportx/app` 下执行，使用部署的 Node 运行时：

```bash
NODE=/opt/transportx/node-runtime/node_modules/node/bin/node
$NODE scripts/web-users.mjs add admin --file /etc/transportx/web-users.json
$NODE scripts/web-users.mjs list - --file /etc/transportx/web-users.json
$NODE scripts/web-users.mjs remove alice --file /etc/transportx/web-users.json
```

账号名支持邮箱。`add` 生成并显示一次随机密码；再次 `add` 同名账号会重置密码。若要指定 10–256 位密码，可通过 `--password-stdin` 从标准输入读取，避免密码出现在命令参数中。白名单文件应为 root 所有、transportx 组可读（0640）；更新后检查权限，运行用户需要读取该文件。密码以 scrypt 哈希保存。删除账号或重置密码后，旧 Cookie 失效；无需重启服务。

登录 Cookie 为 HttpOnly、SameSite=Lax，HTTPS 下附加 Secure，有效期 7 天。服务端只持久化随机会话令牌的 SHA-256 摘要，保存在数据根目录的 `web-sessions.json`。退出会删除对应会话，重启保留未过期登录。WebSocket 每 20 秒重新检查认证。

## Nginx 与域名

1. 添加 `app.transkgllm.com` 的 A 记录，值为 `47.111.119.131`；保留根域名和 download 子域的现有记录。
2. ECS 安全组允许 TCP 80/443；Node 继续监听 `127.0.0.1:3000`，不开放 3000。
3. 安装 Nginx、Certbot，先启用 `nginx/transportx.conf` 中的 HTTP server 段，创建 `/var/www/transportx-acme`。
4. 域名解析生效后申请证书：`certbot certonly --webroot -w /var/www/transportx-acme -d app.transkgllm.com`。
5. 启用完整 Nginx 配置，执行 `nginx -t` 和 `systemctl reload nginx`；使用 `certbot renew --dry-run` 验证续期，并设置续期 deploy hook 重载 Nginx。

公开入口只通过 HTTPS 提供登录；HTTP 跳转 HTTPS。反向代理保留 Host、覆盖 X-Forwarded-Proto，并支持 WebSocket 和长任务。服务端白名单认证在 SSH 隧道访问时同样生效。

## 当前服务器

- 地址：`https://app.transkgllm.com`；服务器 `47.111.119.131`。
- 应用目录：`/opt/transportx/app`；共享数据与模块：`/var/lib/transportx`。
- 服务用户：`transportx`；启动配置：`/etc/transportx/web.env`；服务：`transportx-web.service`。
- Nginx 配置：`/etc/nginx/conf.d/transportx.conf`；Node 仅监听 `127.0.0.1:3000`。
- HTTPS：Let's Encrypt；续期：`certbot.timer`；续期后的重载脚本：`/etc/letsencrypt/renewal-hooks/deploy/transportx-nginx`。

SSH 登录后可用 `systemctl status transportx-web nginx` 查看状态，`journalctl -u transportx-web -n 80 --no-pager` 查看应用日志。更新代码后只构建 server、web、react，再执行 `systemctl restart transportx-web`；不要在该服务器执行全量 Electron 构建或覆盖共享数据目录。
