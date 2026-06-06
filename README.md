# FirstMail 工具

一个零依赖的本地 Node 工具，包含两个页面：

- **批量修改密码**（`/`）：粘贴 `邮箱:当前密码`，统一改成新密码；支持并发、结果统计、导出当前数据 / 当前邮箱（可编辑后下载 txt）、一键同步到邮件查看器。
- **邮件查看器**（`/messages.html`）：粘贴 `邮箱:密码`，按账号拉取邮件、查看正文、按时间倒序、一键复制邮箱。

后端 `server.js` 只做静态托管 + 转发 FirstMail 接口，**API Key 放在服务端**（环境变量），浏览器不接触。

> ⚠️ 本工具能批量改密码、读取所有邮件，且**没有内置登录验证**。请只在本机或通过 Nginx 反代（IP 白名单 / Basic Auth）限制访问，**不要把它裸暴露在公网**。

## 环境要求

- Node.js **18+**（用到内置 `fetch`，无需 `npm install`）

## 快速开始（本地）

```bash
git clone https://github.com/BojianZhang/firstmail.git
cd firstmail
cp .env.example .env      # 然后编辑 .env，填入真实 FIRSTMAIL_API_KEY
node server.js
```

打开 http://127.0.0.1:8787/

## 配置（.env）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `FIRSTMAIL_API_KEY` | 是 | — | FirstMail 接口密钥，未设置则拒绝启动 |
| `PORT` | 否 | `8787` | 监听端口 |
| `HOST` | 否 | `127.0.0.1` | 监听地址；Nginx 反代时保持 `127.0.0.1` |

`.env` 已被 `.gitignore` 忽略，不会提交。

## Ubuntu 服务器部署

见 [DEPLOY.md](DEPLOY.md)（systemd 常驻 + Nginx 反代 + HTTPS + 访问保护）。
