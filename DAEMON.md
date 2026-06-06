# 守护进程部署文档（Ubuntu）

把 FirstMail 工具作为后台守护进程长期运行，要求：**开机自启、崩溃自动重启、统一日志**。

推荐用系统自带的 **systemd**（无需额外安装）。文末附 **pm2** 备选方案。

---

## 零、前提条件

```bash
# 1) 安装 Node.js 18+ 和 git（用到内置 fetch，无需 npm install）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v        # 必须 >= 18

# 2) 拉取代码到 /opt/firstmail
sudo mkdir -p /opt/firstmail
sudo chown "$USER":"$USER" /opt/firstmail
git clone https://github.com/BojianZhang/firstmail.git /opt/firstmail
cd /opt/firstmail

# 3) 配置 API Key
cp .env.example .env
nano .env       # 填入真实 FIRSTMAIL_API_KEY，按需改 PORT/HOST

# 4) 手动验证能启动（看到 listening 字样即正常，Ctrl+C 退出）
node server.js
```

确认 node 的绝对路径（写进 service 文件要用）：

```bash
which node      # 一般是 /usr/bin/node
```

---

## 一、systemd 方式（推荐）

### 1. 安装服务文件

仓库自带模板 `firstmail.service`，直接复制到 systemd 目录：

```bash
sudo cp /opt/firstmail/firstmail.service /etc/systemd/system/firstmail.service
```

然后按实际情况编辑（核对 `WorkingDirectory`、`ExecStart` 的 node 路径、`User`）：

```bash
sudo nano /etc/systemd/system/firstmail.service
```

> 不想用仓库模板，也可以用一条命令直接生成：
> ```bash
> sudo tee /etc/systemd/system/firstmail.service >/dev/null <<'EOF'
> [Unit]
> Description=FirstMail Tool
> After=network.target
>
> [Service]
> Type=simple
> WorkingDirectory=/opt/firstmail
> ExecStart=/usr/bin/node server.js
> Restart=always
> RestartSec=3
> User=www-data
> Group=www-data
>
> [Install]
> WantedBy=multi-user.target
> EOF
> ```

### 2. 配置运行用户的读取权限

服务默认以 `www-data` 身份运行，要保证它能读到代码和 `.env`：

```bash
sudo chown -R www-data:www-data /opt/firstmail
sudo chmod 600 /opt/firstmail/.env
```

> 想以自己的用户运行：把 service 里的 `User=`/`Group=` 改成你的用户名（如 `ubuntu`），上面 chown 的目标也换成它。

### 3. 启动并设为开机自启

```bash
sudo systemctl daemon-reload          # 重新加载 systemd 配置
sudo systemctl enable --now firstmail # 立即启动 + 开机自启
```

### 4. 验证

```bash
sudo systemctl status firstmail       # Active: active (running) 即成功
curl -I http://127.0.0.1:8787/        # 返回 200 即守护进程正常服务
```

### 5. 日常管理命令

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `sudo systemctl status firstmail` |
| 实时日志 | `journalctl -u firstmail -f` |
| 最近日志 | `journalctl -u firstmail -e` |
| 重启（改代码/改 .env 后） | `sudo systemctl restart firstmail` |
| 停止 | `sudo systemctl stop firstmail` |
| 启动 | `sudo systemctl start firstmail` |
| 取消开机自启 | `sudo systemctl disable firstmail` |

### 6. 更新代码后重启

```bash
cd /opt/firstmail
git pull
sudo systemctl restart firstmail
```

### 7. 排错

先看日志：`journalctl -u firstmail -e`

- **`[启动失败] 未设置 FIRSTMAIL_API_KEY`**：`.env` 没配好，或 `www-data` 读不到。检查第 2 步权限，或改用 service 里的 `Environment=` 直接注入 Key。
- **`Error: listen EADDRINUSE ... 8787`**：端口被占用。改 `.env` 里 `PORT`，或 `sudo lsof -i:8787` 找到并停掉占用进程，然后 `sudo systemctl restart firstmail`。
- **`status` 显示 `code=exited, status=203/EXEC`**：`ExecStart` 的 node 路径不对。用 `which node` 核对后改 service，再 `daemon-reload` + `restart`。
- **改了 service 文件不生效**：改完必须 `sudo systemctl daemon-reload` 再 `restart`。

---

## 二、pm2 方式（备选）

适合喜欢用 Node 进程管理器、需要日志切割的场景。

```bash
# 安装 pm2
sudo npm install -g pm2

cd /opt/firstmail
# .env 已在目录里，server.js 会自动读取
pm2 start server.js --name firstmail

# 设为开机自启（按提示执行它输出的那条 sudo 命令）
pm2 startup
pm2 save
```

常用命令：

```bash
pm2 status                 # 查看状态
pm2 logs firstmail         # 实时日志
pm2 restart firstmail      # 重启
pm2 stop firstmail         # 停止
pm2 delete firstmail       # 移除
```

更新代码：

```bash
cd /opt/firstmail && git pull && pm2 restart firstmail
```

---

## 三、对外访问与安全

守护进程默认只监听 `127.0.0.1:8787`，外网访问不到。要让外部能用，请配 **Nginx 反代 + HTTPS**，并务必加 **Basic Auth / IP 白名单**（本工具能批量改密码、读所有邮件，且无登录验证）。

完整的 Nginx 反代 + certbot HTTPS + 访问保护步骤见 [DEPLOY.md](DEPLOY.md)。
