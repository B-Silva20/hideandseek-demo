# 案件审讯 Demo

本次仅完成**第一步：初始化项目和运行环境**。技术栈为 React + TypeScript + Vite 前端、Node.js + Express 后端。首页展示前后端连通情况和必需环境变量的配置状态。

## 运行环境

- Node.js 22.12 或更新版本（当前验证环境：24.16.0）
- npm 10 或更新版本（当前验证环境：11.13.0）

在项目根目录执行：

```powershell
npm install
npm run dev
```

- 首页：<http://localhost:5173>
- 后端健康检查：<http://127.0.0.1:3001/api/health>
- `npm run dev` 同时启动前后端，按 `Ctrl+C` 停止。
- 端口固定为 5173 和 3001；如被占用，启动命令会明确报错。

也可以在两个终端分别运行：

```powershell
# 终端一：前端
npm run dev:client
```

```powershell
# 终端二：后端
npm run dev:server
```

前端通过 Vite 将 `/api` 代理到 `127.0.0.1:3001`。单独启动前端时首页仍能打开，并提示启动后端。

## 环境变量

首次配置时复制示例文件，再在本机编辑 `.env`：

```powershell
Copy-Item .env.example .env
```

已有 `.env` 时直接编辑，不要用示例覆盖现有配置。

```dotenv
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
DATABASE_URL=
```

- 四项均预留在 `.env.example` 中。`LLM_BASE_URL` 应为 HTTP(S) 基础地址，不包含用户名、密码、查询参数或片段。
- `.env` 仅由后端读取；Vite 禁止加载环境文件和注入自定义环境变量。前端请求只发送相对 `/api/health`，不携带 API Key。
- 后端日志、错误响应和健康检查仅返回缺失或无效的**变量名**，不输出配置值、请求内容或原始异常。
- `.env` 已排除 Git 提交。不要将密钥加上 `VITE_` 前缀，也不要粘贴到前端代码、浏览器请求参数或日志。
- 环境变量缺失时，前后端仍可运行，首页和后端终端会给出明确提示。
- 修改 `.env` 后重启后端。当前“配置完成”仅表示变量已填写及基础地址格式检查通过，不代表模型或数据库连接成功。

## 目录

```text
src/
  components/     首页状态组件
  engine/         游戏引擎预留目录
  data/           公开数据预留目录
  types/          前端类型
server/
  routes/         API 路由（当前仅健康检查）
  services/       服务层预留目录
  prompts/        模型提示词预留目录
  config.ts       后端环境配置及脱敏状态
  app.ts          Express 应用
  index.ts        API 启动入口
tests/
  fixtures/
    private/      仅供本地使用的测试案件
  server.test.ts  配置和 API 边界检查
```

`tests/fixtures/private/占星术杀人魔法.txt` 为本机测试用副本，已排除 Git 提交。Vite 禁止访问 `tests/`、`server/`、`dist-server/` 和环境文件；后端没有静态文件托管接口。测试案件不会进入前端或后端构建产物，不能由前端导入。公开版本后续仅使用原创或已获授权的短篇案件。

## 验证与构建

```powershell
npm test
npm run lint
npm run build
```

构建产物：`dist/` 为前端，`dist-server/` 为后端。

本地验证构建产物时，在两个终端分别执行（先停止开发服务，避免占用 API 端口）：

```powershell
npm run start:server
```

```powershell
npm run preview
```

预览地址：<http://localhost:4173>。预览服务器同样代理 `/api` 到后端；`preview` 用于本地检查，公开部署方式留待后续步骤。

## 手机访问

前端监听 `0.0.0.0:5173`。电脑与手机连接同一局域网后，在手机浏览器打开启动输出中对应 WLAN 或有线网卡的 `Network` 地址。如果不可达，检查局域网隔离及 Windows 防火墙设置。后端仅监听本机回环地址，手机 API 请求由前端服务器代理。

## 本步范围

当前尚未接入真实模型调用、数据库、案件解析、上传、审讯、行动点、结局、匿名进度或公开部署；对应实现属于后续经确认的步骤。
