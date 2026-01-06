// 在 Zotero 控制台运行此代码检查加载错误

// 1. 检查文件是否存在
const fileURL = 'chrome://s3sync/content/scripts/s3sync.js';
console.log('Checking file:', fileURL);

// 2. 手动创建上下文并加载
const ctx = {
  rootURI: 'chrome://s3sync/',
  Zotero: Zotero,
  Components: Components,
  Services: Services,
  ChromeUtils: ChromeUtils,
  console: console
};
ctx._globalThis = ctx;

// 3. 尝试加载
try {
  console.log('Loading script with context...');
  Services.scriptloader.loadSubScript(fileURL, ctx);
  console.log('Script loaded!');
  console.log('ctx.addon:', ctx.addon);
  console.log('ctx._globalThis:', ctx._globalThis);
  console.log('Zotero.S3Sync:', Zotero.S3Sync);

  // 如果 ctx.addon 存在但 Zotero.S3Sync 不存在，手动设置
  if (ctx.addon && !Zotero.S3Sync) {
    console.log('Manually setting Zotero.S3Sync...');
    Zotero.S3Sync = ctx.addon;
    console.log('Set! Zotero.S3Sync:', Zotero.S3Sync);
  }
} catch (e) {
  console.error('Error loading script:', e);
  console.error('Stack:', e.stack);
}
