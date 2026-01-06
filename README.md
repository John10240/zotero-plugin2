# Zotero S3 同步插件

这是一个用于将 Zotero 附件同步到 S3 兼容存储的插件。

## 功能特性

- ✅ 将 Zotero 附件上传到 S3 兼容存储
- ✅ 支持增量同步（仅同步变更的文件）
- ✅ 支持任何 S3 兼容的对象存储（AWS S3、MinIO、阿里云 OSS 等）
- ✅ 可配置的文件前缀
- ✅ 连接测试功能
- ✅ 同步进度显示

## 安装

1. 从 Releases 页面下载最新的 `.xpi` 文件
2. 在 Zotero 中，打开 工具 -> 插件
3. 点击右上角的齿轮图标，选择 "从文件安装插件"
4. 选择下载的 `.xpi` 文件
5. 重启 Zotero

## 配置

1. 打开 Zotero -> 编辑 -> 设置 -> S3 同步设置
2. 配置以下信息：

   - **S3 端点**: S3 服务的端点 URL（例如：`https://s3.amazonaws.com`）
   - **区域**: S3 区域（例如：`us-east-1`）
   - **存储桶名称**: 你的 S3 存储桶名称
   - **访问密钥 ID**: S3 访问密钥 ID
   - **秘密访问密钥**: S3 秘密访问密钥
   - **文件前缀**: 存储在 S3 中的文件路径前缀（默认：`zotero-attachments`）

3. 点击"测试连接"按钮验证配置是否正确

## 使用方法

### 手动同步

1. 打开 Zotero
2. 点击菜单栏 工具 -> 同步到 S3
3. 插件会自动检测所有需要同步的附件并开始上传
4. 同步进度会显示在弹出窗口中

### 自动同步

在设置中勾选"启用自动同步"即可启用自动同步功能（计划中）。

## S3 兼容存储配置示例

### AWS S3

```
端点: https://s3.amazonaws.com
区域: us-east-1 (或其他区域)
```

### MinIO

```
端点: http://localhost:9000 (或你的 MinIO 服务器地址)
区域: us-east-1 (MinIO 默认区域)
```

### 阿里云 OSS

```
端点: https://oss-cn-hangzhou.aliyuncs.com (根据你的区域修改)
区域: oss-cn-hangzhou (根据你的区域修改)
```

### 腾讯云 COS

```
端点: https://cos.ap-guangzhou.myqcloud.com (根据你的区域修改)
区域: ap-guangzhou (根据你的区域修改)
```

## 工作原理

1. 插件会扫描 Zotero 库中的所有附件文件
2. 计算每个文件的 MD5 哈希值
3. 将哈希值与上次同步时的哈希值对比
4. 只上传有变化的文件到 S3
5. 记录同步时间和文件哈希值

## 开发

### 环境要求

- Node.js 18+
- npm 或 pnpm
- Zotero 7 Beta

### 构建

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm start

# 生产构建
npm run build
```

构建产物位于 `.scaffold/build/` 目录。

### 项目结构

```
src/
├── modules/
│   ├── s3Client.ts        # S3 客户端封装
│   ├── syncManager.ts     # 同步管理器
│   ├── examples.ts        # 示例代码
│   └── preferenceScript.ts # 偏好设置脚本
├── utils/                 # 工具函数
├── hooks.ts               # 生命周期钩子
├── addon.ts               # 插件主类
└── index.ts               # 入口文件
```

## 常见问题

### Q: 支持下载文件吗？

A: 目前版本主要实现了上传功能。下载功能的 API 已经实现，但还需要在 UI 中集成。

### Q: 文件会被压缩吗？

A: 不会。文件以原始格式上传到 S3。

### Q: 如何删除 S3 上的文件？

A: 插件目前不支持自动删除功能。你需要手动在 S3 控制台中删除不需要的文件。

### Q: 同步失败怎么办？

A: 请检查：
1. S3 配置是否正确
2. 网络连接是否正常
3. S3 存储桶权限是否足够
4. 查看 Zotero 的调试输出（帮助 -> 调试输出日志）

## 许可证

AGPL-3.0-or-later

## 致谢

本插件基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 构建。
