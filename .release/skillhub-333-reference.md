# SkillHub 333 发布参考

时间：2026-07-01

## 当前确认到的事实

- 页面入口：
  - `https://skylink-gateway.com/skillhub/333`
- 该地址返回的是前端壳页面，不是 zip / tgz 直链。
- 前端资源里能确认存在后台接口：
  - `/api/v1/admin/auth/me`
  - `/api/v1/admin/auth/login`
  - `/api/v1/admin/auth/logout`
  - `/api/v1/admin/skillhub/skills/333`
- 直接请求：
  - `GET https://skylink-gateway.com/api/v1/admin/skillhub/skills/333`
  - 返回 `401`，响应为：`{"status":"fail","message":"缺少 token","data":{}}`

结论：

- SkillHub 333 目前不能匿名下载。
- 要拿到真实 skill 内容，必须使用已登录态（cookie 或 token）再请求后台接口，或在页面登录后抓真实下载请求。

## 后续下载方式

### 方案 A：你提供登录态

可用任一项：

- 浏览器导出的请求头里的 `Authorization`
- 已登录 cookie
- 该 skill 的导出包 / 压缩包

拿到后即可做：

1. 下载原始 skill
2. 解包到本地临时目录
3. 审查其目录结构、脚本、发布说明
4. 提炼适合 `Aigc-platform` 的发布流程

### 方案 B：你在页面里手动下载，我来吸收经验

你把下载得到的文件放到本地后，我继续：

1. 对比它的 `SKILL.md`、脚本、模板
2. 提炼它的发布 SOP
3. 合并到当前项目的 `.release/` 流程

## 对当前项目可直接借鉴的点

即使还没拿到 skill 包，结合 SkillHub 这种形态，后续发布能力建议统一成下面四层：

1. `打包`
   - 明确 runtime 白名单
   - 明确排除目录
   - 固定产物命名

2. `上传`
   - 固定 JumpServer / Bastion 上传脚本
   - 固定远端落点，例如 `/tmp/...`

3. `部署`
   - 远端只重建 app
   - 不碰 `users.json` / `config.json` / `mysql-data`
   - 预留 rollback tag 和代码备份

4. `验收`
   - 容器状态
   - 本机 `curl`
   - 关键接口 smoke test
   - 关键日志路径检查

## 建议的下一步

等你拿到 SkillHub 333 的登录态或导出包后，继续做两件事：

1. 把这个 skill 真正下载下来并安装/归档
2. 把它的发布经验抽成当前项目的标准发布模板
