# 手动安装和测试插件

## 问题诊断

从控制台输出可以看到：
- `Zotero.S3Sync` 是 `undefined` - **插件没有加载**
- 手动注册偏好面板可以打开设置界面
- 但是因为插件代码没加载，所以按钮点击没有反应

## 解决方案：正确安装插件

### 步骤 1：确认插件文件

```bash
cd zotero-plugin2
npm run build
ls -lh .scaffold/build/zotero-s-3-sync.xpi
```

### 步骤 2：在 Zotero 中检查插件

打开 Zotero，按 `Ctrl+Shift+A`（或 工具 -> 插件），检查：

1. **是否看到 "Zotero S3 Sync" 插件？**
   - 如果没有 → 插件没有安装，需要安装
   - 如果有但被禁用 → 启用它
   - 如果有且已启用 → 继续下一步

2. **查看插件详情**：
   - ID: `s3sync@zotero.plugin`
   - 版本: `0.1.0`

### 步骤 3：完全重新安装

**重要：必须完全关闭 Zotero 才能正确安装**

1. **完全关闭 Zotero**
   - 关闭所有 Zotero 窗口
   - 打开任务管理器，确保没有 `zotero.exe` 进程

2. **删除旧插件文件**（如果存在）
   - 找到 Zotero 配置目录：
     ```
     Windows: C:\Users\你的用户名\AppData\Roaming\Zotero\Zotero\Profiles\xxxxx.default\extensions
     ```
   - 删除 `s3sync@zotero.plugin.xpi` 或 `s3sync@zotero.plugin` 文件夹

3. **重新启动 Zotero**

4. **安装插件**
   - 工具 -> 插件
   - 齿轮图标 -> 从文件安装插件
   - 选择 `E:\git\zotero-plugin2\.scaffold\build\zotero-s-3-sync.xpi`
   - **必须重启 Zotero**

5. **验证安装**
   - 重启后，打开控制台（Ctrl+Shift+J）
   - 运行：`console.log('Plugin:', Zotero.S3Sync)`
   - **应该看到一个对象，不是 undefined**

### 步骤 4：如果插件仍然是 undefined

在 Zotero 控制台运行以下命令，手动加载插件：

```javascript
// 获取插件路径（替换为你的实际路径）
const addonPath = 'file:///E:/git/zotero-plugin2/.scaffold/build/addon/';

// 创建上下文
const ctx = { rootURI: addonPath };
ctx._globalThis = ctx;

// 手动加载插件脚本
try {
  Services.scriptloader.loadSubScript(
    addonPath + 'content/scripts/s3sync.js',
    ctx
  );
  console.log('Script loaded, checking Zotero.S3Sync:', Zotero.S3Sync);

  // 如果成功加载，初始化插件
  if (Zotero.S3Sync) {
    await Zotero.S3Sync.hooks.onStartup();
    console.log('Plugin initialized!');
  }
} catch (e) {
  console.error('Failed to load plugin:', e);
}
```

### 步骤 5：使用开发模式（推荐）

开发模式会自动重新加载插件，更方便测试：

1. **创建 `.env` 文件**：

```bash
cd zotero-plugin2
cp .env.example .env
```

2. **编辑 `.env` 文件**，设置你的 Zotero 路径：

Windows:
```env
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=C:\Program Files\Zotero\zotero.exe
ZOTERO_PLUGIN_PROFILE_PATH=C:\Users\YC\Zotero
```

3. **启动开发模式**：

```bash
npm start
```

这会自动启动 Zotero 并加载插件，修改代码后会自动重新加载。

### 步骤 6：查看加载错误

如果插件加载失败，通常会有错误信息：

1. **帮助 -> 调试输出日志 -> 启用 -> 查看输出**
2. 重启 Zotero
3. 查找包含 `s3sync` 或 `S3Sync` 的错误信息

常见错误：
- `NS_ERROR_FILE_NOT_FOUND` - 文件路径错误
- `SyntaxError` - JavaScript 语法错误
- `ReferenceError` - 引用了未定义的变量

## 快速测试：直接运行构建的代码

在 Zotero 控制台运行以下完整代码来测试插件功能：

```javascript
// 临时加载插件用于测试
const testPlugin = async () => {
  // 检查 AWS SDK 是否可用
  try {
    const { S3Client } = await import('chrome://zotero/content/scripts/s3sync.js');
    console.log('S3Client loaded');
  } catch (e) {
    console.error('Failed to load S3Client:', e);
  }

  // 测试 S3 连接（使用你的配置）
  const endpoint = prompt('Enter S3 endpoint (e.g., https://s3.amazonaws.com):');
  const region = prompt('Enter region (e.g., us-east-1):');
  const accessKeyId = prompt('Enter Access Key ID:');
  const secretAccessKey = prompt('Enter Secret Access Key:');
  const bucketName = prompt('Enter bucket name:');

  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucketName) {
    console.log('Test cancelled - missing configuration');
    return;
  }

  // 保存配置到 Zotero 偏好设置
  Zotero.Prefs.set('extensions.zotero.s3sync.s3.endpoint', endpoint);
  Zotero.Prefs.set('extensions.zotero.s3sync.s3.region', region);
  Zotero.Prefs.set('extensions.zotero.s3sync.s3.accessKeyId', accessKeyId);
  Zotero.Prefs.set('extensions.zotero.s3sync.s3.secretAccessKey', secretAccessKey);
  Zotero.Prefs.set('extensions.zotero.s3sync.s3.bucketName', bucketName);

  console.log('Configuration saved to Zotero preferences');
};

testPlugin();
```

## 我需要你提供的信息

请运行以下命令并告诉我输出：

```javascript
// 1. Zotero 版本
console.log('Zotero version:', Zotero.version);

// 2. 已安装的插件
console.log('Installed addons:',
  Array.from(Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).directoryEntries)
    .filter(f => f.leafName.includes('xpi') || f.leafName.includes('@'))
    .map(f => f.leafName)
);

// 3. 插件对象
console.log('S3Sync object:', typeof Zotero.S3Sync, Zotero.S3Sync);

// 4. 扩展管理器中的插件
const { AddonManager } = ChromeUtils.import('resource://gre/modules/AddonManager.jsm');
AddonManager.getAllAddons().then(addons => {
  console.log('All addons:', addons.map(a => ({id: a.id, name: a.name, enabled: a.isActive})));
});
```

把这些输出发给我，我可以帮你精确定位问题。
