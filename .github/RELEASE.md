# 自动发布使用指南

## 快速开始

### 发布新版本

1. **更新版本号**

   编辑 `package.json`，更新 `version` 字段：
   ```json
   {
     "version": "0.1.1"
   }
   ```

2. **提交更改**
   ```bash
   git add package.json
   git commit -m "chore: bump version to 0.1.1"
   git push origin main
   ```

3. **创建并推送 tag**
   ```bash
   # 创建 tag（tag 名称必须以 v 开头）
   git tag v0.1.1

   # 推送 tag 到远程仓库（这会触发自动发布）
   git push origin v0.1.1
   ```

4. **等待自动构建**
   - 访问 https://github.com/John10240/zotero-plugin2/actions
   - 查看 "Release" workflow 的运行状态
   - 构建完成后，Release 会自动创建

## Release 包含内容

自动发布的 Release 将包含：

- ✅ **XPI 安装包** - Zotero 插件安装文件
- ✅ **Changelog** - 自动生成的更新日志（基于 commit 历史）
- ✅ **Update manifest** - update.json 和 update-beta.json
- ✅ **Source code** - 源代码压缩包（GitHub 自动生成）

## Commit 规范建议

为了生成高质量的 Changelog，建议使用规范的 commit message 格式：

```
<type>(<scope>): <subject>

<body>
```

### Type 类型
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建或辅助工具变动

### 示例
```bash
git commit -m "feat: 实现三向合并同步引擎"
git commit -m "fix(s3): 修复文件上传失败的问题"
git commit -m "docs: 更新 README 添加使用说明"
```

## 测试发布流程

如果想测试发布流程而不创建正式版本，可以使用预发布 tag：

```bash
# 创建预发布 tag
git tag v0.1.1-beta.1

# 推送 tag
git push origin v0.1.1-beta.1
```

## 常见问题

### Q: 发布失败了怎么办？

1. 检查 GitHub Actions 日志查看错误信息
2. 确认 repository 的 Actions 权限已启用
3. 确认 tag 格式正确（必须以 `v` 开头）

### Q: 如何删除错误的 Release？

1. 在 GitHub Releases 页面删除 Release
2. 删除本地 tag: `git tag -d v0.1.1`
3. 删除远程 tag: `git push origin :refs/tags/v0.1.1`

### Q: Changelog 内容不符合预期？

Changelog 是基于 commit 历史自动生成的。要改善 Changelog 质量：
- 使用规范的 commit message
- 在 commit message 中提供清晰的描述
- 考虑手动编辑 Release notes

## 版本号规范

建议遵循 [Semantic Versioning](https://semver.org/)：

- **MAJOR.MINOR.PATCH** (例如: 1.2.3)
- MAJOR: 不兼容的 API 变更
- MINOR: 向后兼容的新功能
- PATCH: 向后兼容的 bug 修复

示例：
- `0.1.0` → `0.1.1` (bug 修复)
- `0.1.0` → `0.2.0` (新功能)
- `0.9.0` → `1.0.0` (首个稳定版)
