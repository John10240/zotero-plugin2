# Zotero S3 同步插件 - 快速开始

## 插件文件位置

构建完成的插件文件：`.scaffold/build/zotero-s-3-sync.xpi`

## 快速安装步骤

1. 打开 Zotero 7
2. 工具 -> 插件 -> 齿轮图标 -> 从文件安装插件
3. 选择 `.scaffold/build/zotero-s-3-sync.xpi`
4. 重启 Zotero

## 配置步骤

### 1. 准备 S3 存储

你需要准备一个 S3 或 S3 兼容的存储服务，例如：
- AWS S3
- MinIO（可本地部署）
- 阿里云 OSS
- 腾讯云 COS
- 其他 S3 兼容服务

### 2. 配置插件

1. Zotero -> 编辑 -> 设置 -> S3 同步设置
2. 填写以下信息：

```
S3 端点: https://你的s3服务地址
区域: us-east-1 (根据实际情况修改)
存储桶名称: 你的存储桶名称
访问密钥 ID: 你的 Access Key
秘密访问密钥: 你的 Secret Key
文件前缀: zotero-attachments (可自定义)
```

3. 点击"测试连接"验证配置

### 3. 开始同步

1. 工具菜单 -> 同步到 S3
2. 等待同步完成

## 示例：使用 MinIO 本地测试

如果你想本地测试，可以使用 Docker 快速启动 MinIO：

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e "MINIO_ROOT_USER=minioadmin" \
  -e "MINIO_ROOT_PASSWORD=minioadmin" \
  minio/minio server /data --console-address ":9001"
```

然后配置插件：
```
S3 端点: http://localhost:9000
区域: us-east-1
存储桶名称: zotero (需要在 MinIO 控制台创建)
访问密钥 ID: minioadmin
秘密访问密钥: minioadmin
```

访问 http://localhost:9001 打开 MinIO 控制台创建存储桶。

## 注意事项

1. **安全性**: 秘密访问密钥会存储在 Zotero 的配置中，请确保你的电脑安全
2. **网络**: 上传大文件可能需要较长时间，请保持网络连接稳定
3. **存储空间**: 确保 S3 存储桶有足够的空间
4. **权限**: 确保 S3 访问密钥有上传文件的权限

## 文件命名规则

文件在 S3 中的路径格式：`{prefix}/{attachment-key}`

例如：`zotero-attachments/ABCD1234`

## 后续开发计划

- [ ] 自动同步功能
- [ ] 下载功能的 UI 集成
- [ ] 删除文件功能
- [ ] 冲突处理
- [ ] 批量下载
- [ ] 同步统计信息

## 问题反馈

如有问题，请查看 Zotero 调试输出：
- 帮助 -> 调试输出日志 -> 查看输出
