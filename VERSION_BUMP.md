# 版本号自动升级指南

## 快速使用

每次需要发布新版本时，只需运行：

```bash
npm run bump
```

这个命令会自动：
1. ✅ 读取当前版本号（如 0.1.3）
2. ✅ 增加补丁版本号（变成 0.1.4）
3. ✅ 更新 package.json
4. ✅ 提交更改到 git
5. ✅ 推送到 main 分支
6. ✅ 创建并推送 tag（如 v0.1.4）
7. ✅ 触发 GitHub Actions 自动构建 release

## 示例

```bash
$ npm run bump

📦 Version bump: 0.1.3 -> 0.1.4
✅ Updated package.json
✅ Committed changes
✅ Pushed to main
✅ Created and pushed tag v0.1.4

🎉 Version bump complete!
📋 New version: 0.1.4
🔗 Check release: https://github.com/John10240/zotero-plugin2/actions
```

## 版本号规则

遵循 [Semantic Versioning](https://semver.org/) 语义化版本规范：

- **格式**: MAJOR.MINOR.PATCH (例如: 1.2.3)
- **MAJOR**: 不兼容的 API 变更（如 1.0.0 → 2.0.0）
- **MINOR**: 向后兼容的新功能（如 1.0.0 → 1.1.0）
- **PATCH**: 向后兼容的 bug 修复（如 1.0.0 → 1.0.1）

`npm run bump` 命令默认增加 **PATCH** 版本号。

## 手动控制版本号

如果需要增加 MAJOR 或 MINOR 版本号，可以手动修改：

### 方法 1: 直接编辑 package.json

```json
{
  "version": "0.2.0"  // 手动改成你需要的版本
}
```

然后运行：
```bash
git add package.json
git commit -m "chore: bump version to 0.2.0"
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

### 方法 2: 使用 npm version 命令

```bash
# 增加主版本号: 0.1.3 -> 1.0.0
npm version major

# 增加次版本号: 0.1.3 -> 0.2.0
npm version minor

# 增加补丁版本号: 0.1.3 -> 0.1.4
npm version patch
```

然后推送：
```bash
git push origin main
git push origin --tags
```

## 注意事项

1. 确保在运行 `npm run bump` 前已提交所有代码更改
2. 需要有 git 推送权限
3. 版本 tag 会自动触发 GitHub Actions 构建 release
4. 构建完成后可在 [Releases](https://github.com/John10240/zotero-plugin2/releases) 页面查看

## 故障排查

### 问题：git push 失败

确保你的 git 配置正确，且有权限推送到远程仓库：

```bash
git remote -v
git config user.name
git config user.email
```

### 问题：tag 已存在

删除旧 tag 后重新创建：

```bash
git tag -d v0.1.4
git push origin :refs/tags/v0.1.4
npm run bump
```

## 相关文档

- [发布流程说明](.github/RELEASE.md)
- [Semantic Versioning 规范](https://semver.org/)
