/* eslint-disable */
// 在 Zotero 控制台运行这个命令来检查插件状态

// 检查 1：Zotero 版本
console.log("=== Zotero Version ===");
console.log("Version:", Zotero.version);
console.log("Platform:", Zotero.platform);

// 检查 2：S3Sync 是否加载
console.log("\n=== Plugin Status ===");
console.log("Zotero.S3Sync:", typeof Zotero.S3Sync);
if (Zotero.S3Sync) {
  console.log("Plugin loaded! Config:", Zotero.S3Sync.data.config);
} else {
  console.log("Plugin NOT loaded!");
}

// 检查 3：已安装的扩展
console.log("\n=== Installed Extensions ===");
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm",
);
AddonManager.getAllAddons().then((addons) => {
  addons.forEach((addon) => {
    console.log(`- ${addon.name} (${addon.id})`);
    console.log(`  Active: ${addon.isActive}, Version: ${addon.version}`);
    if (addon.id === "s3sync@zotero.plugin") {
      console.log("  >>> THIS IS OUR PLUGIN <<<");
    }
  });
});

// 检查 4：偏好设置
console.log("\n=== S3 Preferences ===");
const prefs = [
  "extensions.zotero.s3sync.s3.endpoint",
  "extensions.zotero.s3sync.s3.region",
  "extensions.zotero.s3sync.s3.bucketName",
];
prefs.forEach((pref) => {
  console.log(`${pref}:`, Zotero.Prefs.get(pref) || "(not set)");
});
