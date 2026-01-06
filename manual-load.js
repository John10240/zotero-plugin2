/* eslint-disable */
// 在 Zotero 控制台运行此代码来手动加载和诊断插件

// 1. 准备上下文
const rootURI = "chrome://s3sync/";
const ctx = { rootURI };
ctx._globalThis = ctx;

// 2. 添加调试信息
ctx.console = console;
ctx.Zotero = Zotero;
ctx.Components = Components;
ctx.Services = Services;
ctx.ChromeUtils = ChromeUtils;

// 3. 尝试加载脚本
try {
  console.log("Loading script...");
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/s3sync.js",
    ctx,
  );
  console.log("Script loaded successfully");
  console.log("ctx._globalThis:", ctx._globalThis);
  console.log("ctx.addon:", ctx.addon);
  console.log("Zotero.S3Sync:", Zotero.S3Sync);
} catch (e) {
  console.error("Failed to load script:", e);
  console.error("Error stack:", e.stack);
}
