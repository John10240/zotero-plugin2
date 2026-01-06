# 快速测试步骤

## 最可能的问题：Zotero 缓存了旧版本

按照以下步骤操作：

### 方案 1：完全清理重装（推荐）

1. **关闭 Zotero**

2. **删除缓存目录**：
   - Windows: `%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions`
   - Mac: `~/Library/Application Support/Zotero/Profiles/<profile>/extensions`
   - Linux: `~/.zotero/zotero/<profile>/extensions`

   找到并删除 `s3sync@zotero.plugin.xpi` 或相关文件

3. **重新构建插件**：
   ```bash
   cd zotero-plugin2
   npm run build
   ```

4. **重新安装**：
   - 启动 Zotero
   - 工具 -> 插件 -> 齿轮图标 -> 从文件安装插件
   - 选择 `.scaffold/build/zotero-s-3-sync.xpi`
   - 重启 Zotero

5. **检查**：
   - 编辑 -> 设置（或 Zotero -> 偏好设置）
   - 应该能看到 "S3 Sync" 或"S3 同步"选项

### 方案 2：使用开发模式（临时测试）

1. 在 Zotero 中打开开发者控制台（Ctrl+Shift+J 或 Cmd+Shift+J）

2. 运行以下代码手动注册：

```javascript
// 手动注册偏好面板
Zotero.PreferencePanes.register({
  pluginID: 's3sync@zotero.plugin',
  src: 'chrome://s3sync/content/preferences.xhtml',
  label: 'S3 Sync Settings',
  image: 'chrome://s3sync/content/icons/favicon.png'
});

console.log('Preference pane registered manually');

// 打开偏好设置窗口
Zotero.Prefs.openPreferences();
```

如果这样能看到设置界面，说明文件本身没问题，只是注册时机有问题。

### 方案 3：检查 Zotero 版本

运行以下命令查看 Zotero 版本：

```javascript
console.log('Zotero version:', Zotero.version);
console.log('Zotero platform:', Zotero.platform);
```

确保是 Zotero 7.0.0 或更高版本。如果是 Zotero 6，偏好设置的注册方式不同。

### 方案 4：使用 npm start 开发模式

如果你有开发环境配置（`.env` 文件），可以使用：

```bash
cd zotero-plugin2
npm start
```

这会启动热重载模式，自动在 Zotero 中加载插件。

## 你现在可以做的

请尝试**方案 1**（完全清理重装），这通常能解决大部分问题。

如果还是不行，请：
1. 打开 Zotero 开发者控制台
2. 运行 `console.log('Plugin:', Zotero.S3Sync)`
3. 运行 `console.log('Panes:', Object.keys(Zotero.PreferencePanes._panes || {}))`
4. 把输出结果告诉我

这样我可以更准确地判断问题出在哪里。
