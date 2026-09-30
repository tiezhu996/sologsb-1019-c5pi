# 访谈文本主题编码工具

`sologsb-1019` 是一个面向质性研究者的本地优先主题编码工作台，使用 SolidJS、TypeScript 和 SUID 从零构建。

## 功能

- 导入带时间码或普通段落形式的访谈转写，自动切分片段。
- 创建任意层级主题树，维护操作定义、备忘录和典型示例。
- 为每个片段分别记录两位编码者的主题判断，并高亮分歧。
- 批量选择片段后重新编码，支持主题合并和按片段拆分。
- 从主题引用快速回到原文，并保留主题级与片段级研究记录。
- 完整撤销重做、操作审计、JSON 完整备份和 CSV 编码结果导出。
- J/K、数字键、Alt+A/Alt+B、搜索与通用撤销快捷键。
- 使用 IndexedDB 和 localStorage 双写保存；刷新或断网后继续工作。
- 使用 BroadcastChannel 监测其他标签页修订，发生并发写入时显示冲突，不会静默覆盖。

## 技术栈

- SolidJS 1.9
- TypeScript 5.9
- SUID Material `@suid/material`
- Vite 7
- IndexedDB / localStorage / BroadcastChannel

## 开发

```bash
npm install
npm run dev
```

开发服务器使用 Vite 默认端口，不在源码中硬编码宿主端口。

## 生产构建

```bash
npm run build
npm run preview
```

生产文件输出到 `dist/`。

## Docker

```bash
docker build -t sologsb-1019 .
docker run --rm -p 10019:80 sologsb-1019
```

容器内由 nginx 监听 `80`，宿主端口 `10019` 仅由根项目端口表或部署命令映射。

## 数据说明

数据保存在浏览器本机，不会发送到远端。多个标签页同时编辑时后写入者不会自动覆盖先写入者；界面会要求研究者明确选择“载入其他标签页版本”或“保留本页并建立新修订”。
