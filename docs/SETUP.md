# 安装与维护

## 服务端

要求：Node.js 24.9 以上；或 Docker Compose。网关仅调用 DeepSeek，模型价格与权限由服务端控制。公开 HTTPS 域名必须属于你，示例域名不能直接使用。

### Docker Compose

1. 克隆仓库，复制 `.env.example` 为 `.env`。
2. 把 `GATEWAY_PUBLIC_BASE` 填成网关对外地址，例如 `https://gateway.example.com`。
3. 执行 `docker compose up -d --build`。
4. 参考 [Caddyfile.example](Caddyfile.example) 配置自己的 HTTPS 代理，转发至 `127.0.0.1:8791`。域名解析、防火墙和证书需按服务器情况配置。
5. 执行 `docker compose exec gateway cat /data/admin-token.txt`，在本机保管初始管理员令牌。面板首次连接时使用它。

不要将网关数据目录作为静态网站公开。命名卷 `gateway-data` 保存数据库与密钥，不要随意删除。网关的管理员接口和模型接口共用 HTTPS 入口，分别用管理员令牌与成员密钥鉴权。

### 不使用 Docker

Linux/macOS：

```sh
GATEWAY_DATA_DIR=./.data HOST=127.0.0.1 PORT=8791 GATEWAY_PUBLIC_BASE=https://gateway.example.com node gateway/server.js
```

PowerShell：

```powershell
$env:GATEWAY_DATA_DIR = './.data'
$env:HOST = '127.0.0.1'
$env:PORT = '8791'
$env:GATEWAY_PUBLIC_BASE = 'https://gateway.example.com'
node gateway/server.js
```

服务自动生成 `gateway.sqlite`、`encryption.key`、`admin-token.txt`。三者均需保密并一起备份；没有加密密钥就无法读取保存的官方密钥。安装 HTTPS 代理并通过系统服务保持网关运行。

本机体验可以把对外地址设成 `http://127.0.0.1:8791`，面板只对回环地址允许 HTTP。这种本机地址不能交给远程成员使用。

## 管理员插件

安装兼容版本 DSH，打开一次桌面版以初始化 desktop profile。通过插件页添加 Release 中的 `.tgz`，或用 `dsh plugin --profile desktop add <文件路径>`。不需要允许任何安装构建脚本。

打开「API 用量管理」，填写网关地址与管理员令牌。地址可以带 `/v1`，插件会规范成管理接口根地址。远程地址必须使用 HTTPS。只有验证成功后，凭据才会写入 DSH 凭据服务；源码和浏览器存储不保存它们。

添加官方 API Key 后即可创建成员密钥。新成员密钥只展示一次，复制密钥和 Base URL 一起交给该成员。

如果已有自己维护的 profile patch，也可给 `team-budget` 行配置 `gatewayBase`；完整连接仍需要管理员令牌。默认安装包没有预置服务器或任何凭据。

## 成员配置

选择自定义 API，协议 OpenAI Chat Completions；填写成员密钥、网关的 `/v1` 地址及允许的模型。辅助模型与子代理如要纳入预算，也需使用同一受管理提供方。成员不安装管理员插件。

预算、模型权限或停用提示需找管理员处理；429 表示频率或并发超限。预算不足时返回 402，无模型权限时返回 403，密钥无效时返回 401。

## 维护边界

- 密钥和用量从创建后开始管理；不导入官方账户历史账单。
- 所有金额为人民币。高峰/空闲计价和日月边界按北京时间。
- 价格表在 `gateway/pricing.js`；新增模型或官方调价前，应先更新表和测试。计价日历目前覆盖 2026–2027。
- 预留按保守输入上界和单次输出上限计算。图片/文件按完整上下文预留，较小预算可能因此拒绝；可降低输出上限或调整预算。
- 不返回完整用量的请求保持占用。核对官方账单后在调用记录中人工输入确认费用，不应直接当作免费。
- 删除官方密钥会清除保存的秘密并停用关联成员密钥；不会替你撤销 DeepSeek 平台上的原始 key。
- 删除成员密钥立即撤销之后的认证；历史费用和进行中的预留不释放。
- 当前提供原生 DSH 管理面板，没有独立网页管理员登录系统。
- 这是早期社区版本，尚未接受独立安全审计，也没有对所有 DSH 版本做兼容测试。

## English quick reference

Deploy the included Node 24.9+ service or Docker Compose stack behind your own HTTPS domain. Set `GATEWAY_PUBLIC_BASE` to that domain. Copy the bootstrap administrator token from the private data directory into the native plugin's connection form. Add a provider key and issue member keys. Members need only the generated key and `/v1` base URL. Keep the entire data directory private and back it up together. See [README.en.md](../README.en.md) for scope and limitations.
