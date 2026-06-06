# Ubuntu 部署文档（Nginx 反代 + 域名 + HTTPS）

架构：浏览器 → Nginx(443, HTTPS) → Node(127.0.0.1:8787) → firstmail.ltd 接口

Node 默认只监听 `127.0.0.1`，外网进不来，全部流量由 Nginx 转发，这是最安全的方式。

以下命令以 Ubuntu 20.04/22.04、部署目录 `/opt/firstmail`、域名 `your-domain.com` 为例。

---

## 1. 安装 Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # 确认 >= 18
```

## 2. 拉取代码

```bash
sudo mkdir -p /opt/firstmail
sudo chown "$USER":"$USER" /opt/firstmail
git clone https://github.com/BojianZhang/firstmail.git /opt/firstmail
cd /opt/firstmail
```

本项目零依赖，**不需要 `npm install`**。

## 3. 配置环境变量

```bash
cp .env.example .env
nano .env        # 填入真实 FIRSTMAIL_API_KEY，按需改 PORT/HOST
```

`.env` 示例：

```
FIRSTMAIL_API_KEY=你的真实APIKey
PORT=8787
HOST=127.0.0.1
```

先手动跑一下验证能启动：

```bash
node server.js
# 看到 "FirstMail batch tool listening on http://127.0.0.1:8787/" 即正常，Ctrl+C 退出
```

## 4. 用 systemd 常驻

新建 `/etc/systemd/system/firstmail.service`：

```ini
[Unit]
Description=FirstMail Tool
After=network.target

[Service]
WorkingDirectory=/opt/firstmail
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# 也可以不用 .env，直接在这里注入环境变量：
# Environment=FIRSTMAIL_API_KEY=你的真实APIKey
# Environment=PORT=8787
# Environment=HOST=127.0.0.1
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

> 用 `.env` 方式时，确保 `.env` 可被 `www-data` 读取：`sudo chown -R www-data:www-data /opt/firstmail`。

启动并设为开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now firstmail
sudo systemctl status firstmail      # 查看运行状态
journalctl -u firstmail -f           # 实时日志
```

## 5. 安装并配置 Nginx 反代

```bash
sudo apt-get install -y nginx
```

新建 `/etc/nginx/sites-available/firstmail`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;   # 批量改密码/拉邮件耗时，调大超时
    }
}
```

启用并重载：

```bash
sudo ln -s /etc/nginx/sites-available/firstmail /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 6. 配置 HTTPS（Let's Encrypt）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

certbot 会自动改写 Nginx 配置、申请证书并配置自动续期。

## 7. ⚠️ 访问保护（强烈建议）

本工具能批量改密码、读所有邮件，且 Node 层没有登录验证。公网域名一旦泄露任何人都能用。
在 Nginx 上加一道 Basic Auth：

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.firstmail_htpasswd youruser   # 设置用户名/密码
```

在上面的 `location /` 里加两行：

```nginx
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.firstmail_htpasswd;
```

然后 `sudo nginx -t && sudo systemctl reload nginx`。

或者只允许你自己的 IP：

```nginx
        allow 1.2.3.4;
        deny all;
```

---

## 更新部署

```bash
cd /opt/firstmail
git pull
sudo systemctl restart firstmail
```

## 常见问题

- **启动报 `未设置 FIRSTMAIL_API_KEY`**：`.env` 没配好或 systemd 读不到。检查 `.env` 内容和文件权限，或改用 systemd 的 `Environment=` 注入。
- **502 Bage Gateway**：Node 没起来。`sudo systemctl status firstmail` / `journalctl -u firstmail -e` 看日志。
- **改了代码不生效**：`git pull` 后要 `sudo systemctl restart firstmail`。
