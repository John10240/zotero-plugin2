# 诊断脚本

## 请在 Zotero 中执行以下操作来诊断问题：

### 1. 完全卸载并重新安装

```bash
# 重新构建
cd zotero-plugin2
npm run build
```

然后：
1. 打开 Zotero
2. 工具 -> 插件
3. 找到 "Zotero S3 Sync" 或任何旧的插件，**点击删除**（不是禁用）
4. **完全关闭 Zotero**（确保任务管理器中没有 zotero.exe 进程）
5. 重新启动 Zotero
6. 工具 -> 插件 -> 齿轮图标 -> 从文件安装插件
7. 选择 `.scaffold/build/zotero-s-3-sync.xpi`
8. 重启 Zotero

### 2. 在 Zotero 开发者控制台中检查

打开 Zotero 后，按 `Ctrl+Shift+J`（Mac: `Cmd+Shift+J`）打开开发者控制台，运行以下命令：

```javascript
// 检查插件是否加载
console.log("Plugin loaded:", typeof Zotero.S3Sync !== 'undefined');

// 检查插件 ID
console.log("Plugin ID:", Zotero.S3Sync?.data?.config?.addonID);

// 列出所有已注册的偏好面板
console.log("Registered preference panes:",
  Zotero.PreferencePanes._panes ?
  Object.keys(Zotero.PreferencePanes._panes) :
  "No panes registered"
);

// 检查我们的偏好面板是否注册
console.log("S3Sync pane registered:",
  Zotero.PreferencePanes._panes?.['s3sync@zotero.plugin']
);

// 查看所有 S3 相关的偏好设置
console.log("S3 Prefs:", {
  endpoint: Zotero.Prefs.get('extensions.zotero.s3sync.s3.endpoint'),
  region: Zotero.Prefs.get('extensions.zotero.s3sync.s3.region'),
  bucket: Zotero.Prefs.get('extensions.zotero.s3sync.s3.bucketName')
});
```

### 3. 手动打开偏好设置窗口

在开发者控制台中运行：

```javascript
// 手动打开偏好设置
Zotero.Prefs.openPreferences();
```

### 4. 检查构建文件

运行以下命令检查构建的 manifest.json：

```bash
cd zotero-plugin2/.scaffold/build/addon
cat manifest.json
```

确认输出中包含：
```json
"preferences": [
  {
    "pane": "s3sync",
    "image": "chrome://s3sync/content/icons/favicon.png",
    "label": "Zotero S3 Sync",
    "src": "chrome://s3sync/content/preferences.xhtml",
    "scripts": []
  }
]
```

### 5. 查看 Zotero 错误日志

1. 帮助 -> 调试输出日志
2. 勾选"启用"
3. 选择"查看输出"
4. 重启 Zotero 并观察日志

查找包含以下关键词的错误：
- `s3sync`
- `preference`
- `S3Sync`
- `manifest`

### 6. 检查偏好设置 URL

在开发者控制台中运行：

```javascript
// 直接打开 S3 Sync 偏好设置
window.openDialog(
  'chrome://s3sync/content/preferences.xhtml',
  'preferences',
  'chrome,titlebar,toolbar,centerscreen,dialog=no'
);
```

如果这个命令能打开窗口，说明文件存在，问题在于注册。

### 7. 强制注册偏好面板

在开发者控制台中运行：

```javascript
// 手动注册偏好面板
Zotero.PreferencePanes.register({
  pluginID: 's3sync@zotero.plugin',
  src: 'chrome://s3sync/content/preferences.xhtml',
  label: 'S3 Sync',
  image: 'chrome://s3sync/content/icons/favicon.png'
});

// 然后打开偏好设置
Zotero.Prefs.openPreferences();
```

### 常见问题

#### 问题 A: 插件列表中看不到插件
**原因**: 插件没有正确安装或被禁用
**解决**: 完全删除后重新安装

#### 问题 B: 插件加载了但没有偏好设置
**原因**: manifest.json 中的 preferences 配置可能在运行时没有被 Zotero 识别
**解决**: 使用上面的 "手动注册偏好面板" 方法

#### 问题 C: Zotero.S3Sync 是 undefined
**原因**: 插件主代码没有正确加载
**解决**: 检查 hooks.ts 中的 onStartup() 是否正确执行

### 如果以上都不行

请提供以下信息：
1. Zotero 版本号（帮助 -> 关于 Zotero）
2. 开发者控制台的输出截图
3. 调试日志的相关部分
4. 插件列表截图

我可以根据这些信息进一步帮你诊断问题。
