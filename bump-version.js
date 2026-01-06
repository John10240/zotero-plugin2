#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

// 读取当前版本
const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
const currentVersion = packageJson.version;

// 解析版本号
const versionParts = currentVersion.split('.');
const major = parseInt(versionParts[0]);
const minor = parseInt(versionParts[1]);
const patch = parseInt(versionParts[2]);

// 增加补丁版本号
const newVersion = `${major}.${minor}.${patch + 1}`;

console.log(`📦 Version bump: ${currentVersion} -> ${newVersion}`);

// 更新 package.json
packageJson.version = newVersion;
writeFileSync('./package.json', JSON.stringify(packageJson, null, 2) + '\n');

console.log('✅ Updated package.json');

// Git 操作
try {
  execSync('git add package.json', { stdio: 'inherit' });
  execSync(`git commit -m "chore: bump version to ${newVersion}"`, { stdio: 'inherit' });
  console.log('✅ Committed changes');

  execSync('git push origin main', { stdio: 'inherit' });
  console.log('✅ Pushed to main');

  execSync(`git tag v${newVersion}`, { stdio: 'inherit' });
  execSync(`git push origin v${newVersion}`, { stdio: 'inherit' });
  console.log(`✅ Created and pushed tag v${newVersion}`);

  console.log('\n🎉 Version bump complete!');
  console.log(`📋 New version: ${newVersion}`);
  console.log(`🔗 Check release: https://github.com/John10240/zotero-plugin2/actions`);
} catch (error) {
  console.error('❌ Git operation failed:', error.message);
  process.exit(1);
}
