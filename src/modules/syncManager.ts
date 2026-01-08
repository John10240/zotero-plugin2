import { S3Manager, S3FileMetadata } from "./s3Client";
import { SyncMetadataManager } from "./syncMetadata";
import { getPref, setPref } from "../utils/prefs";

type SyncOperationType =
  | "upload"
  | "download"
  | "conflict"
  | "delete-local"
  | "delete-remote"
  | "no-change";

interface SyncOperation {
  type: SyncOperationType;
  attachmentKey: string;
  localHash?: string;
  remoteETag?: string;
  localModTime?: number;
  remoteModTime?: number;
  lastSyncHash?: string;
  filePath?: string;
}

interface SyncOperations {
  upload: SyncOperation[];
  download: SyncOperation[];
  conflicts: SyncOperation[];
  deleteLocal: SyncOperation[];
  deleteRemote: SyncOperation[];
  noChange: SyncOperation[];
}

interface SyncItem {
  itemID: number;
  attachmentKey: string;
  filePath: string;
  hash: string;
  lastSync: number;
  modTime: number;
}

interface SyncConflict {
  item: SyncItem;
  localModTime: number;
  s3ModTime: number;
  resolution?: "upload" | "download" | "skip";
}

type ConflictResolutionStrategy =
  | "ask"
  | "local-wins"
  | "remote-wins"
  | "newer-wins";

export class SyncManager {
  private s3Manager: S3Manager;
  private metadataManager: SyncMetadataManager;
  private syncQueue: SyncItem[] = [];
  private isSyncing: boolean = false;
  private static readonly METADATA_FILE_KEY = ".zotero-sync-metadata.json";
  private hasCloudMetadata: boolean = false; // Track if cloud has sync records
  private static readonly DEFAULT_CONCURRENCY = 3; // Default concurrent operations

  constructor() {
    this.s3Manager = new S3Manager();
    this.metadataManager = new SyncMetadataManager();
  }

  /**
   * Execute operations concurrently with a limit
   */
  private async executeConcurrently<T>(
    items: T[],
    executor: (item: T) => Promise<boolean>,
    onProgress: (completed: number, total: number, item: T) => void,
    concurrency: number = SyncManager.DEFAULT_CONCURRENCY,
  ): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;
    const total = items.length;

    // Process items in batches
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const success = await executor(item);
            return { success, item };
          } catch (error) {
            ztoolkit.log(`Error executing operation:`, error);
            return { success: false, item };
          }
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          if (result.value.success) {
            completed++;
          } else {
            failed++;
          }
          onProgress(completed + failed, total, result.value.item);
        } else {
          failed++;
        }
      }
    }

    return { completed, failed };
  }

  /**
   * Get the metadata file key in S3
   */
  private getMetadataS3Key(): string {
    const prefix = (getPref("s3.prefix") as string) || "zotero-attachments";
    return `${prefix}/${SyncManager.METADATA_FILE_KEY}`;
  }

  /**
   * Generate a unique bucket identifier
   */
  private getBucketId(): string {
    const endpoint = (getPref("s3.endpoint") as string) || "";
    const bucketName = (getPref("s3.bucketName") as string) || "";
    return `${endpoint}/${bucketName}`;
  }

  /**
   * Download metadata from S3
   */
  private async downloadCloudMetadata(): Promise<boolean> {
    try {
      const metadataKey = this.getMetadataS3Key();
      ztoolkit.log(`尝试下载云端元数据: ${metadataKey}`);

      const blob = await this.s3Manager.downloadFile(metadataKey);

      if (!blob) {
        ztoolkit.log("云端元数据不存在（首次同步或新存储桶）");
        this.hasCloudMetadata = false;
        return false;
      }

      const cloudMetadata = await this.metadataManager.loadFromBlob(blob);
      const currentBucketId = this.getBucketId();

      ztoolkit.log(`云端元数据加载成功: ${Object.keys(cloudMetadata.files).length} 个文件记录`);

      // Check if we're switching buckets
      const localBucketId = this.metadataManager.getBucketId();
      if (localBucketId && localBucketId !== currentBucketId) {
        ztoolkit.log(`检测到切换存储桶:`);
        ztoolkit.log(`  本地: ${localBucketId}`);
        ztoolkit.log(`  当前: ${currentBucketId}`);
        ztoolkit.log(`使用云端元数据替换本地元数据`);
        // Switching buckets - use cloud metadata as source of truth
        cloudMetadata.bucketId = currentBucketId;
        this.metadataManager.replaceWithCloudMetadata(cloudMetadata);
      } else {
        // Same bucket - merge metadata
        cloudMetadata.bucketId = currentBucketId;
        this.metadataManager.mergeWithCloudMetadata(cloudMetadata);
      }

      this.hasCloudMetadata = true;
      return true;
    } catch (error) {
      ztoolkit.log("下载云端元数据失败:", error);
      this.hasCloudMetadata = false;
      return false;
    }
  }

  /**
   * Upload metadata to S3
   */
  private async uploadCloudMetadata(): Promise<boolean> {
    try {
      const metadataKey = this.getMetadataS3Key();
      const currentBucketId = this.getBucketId();

      // Set bucket ID before uploading
      this.metadataManager.setBucketId(currentBucketId);

      const blob = this.metadataManager.toBlob();
      ztoolkit.log(`上传云端元数据到: ${metadataKey}`);

      const success = await this.s3Manager.uploadFile(blob, metadataKey);

      if (success) {
        ztoolkit.log("云端元数据上传成功");
      } else {
        ztoolkit.log("云端元数据上传失败");
      }

      return success;
    } catch (error) {
      ztoolkit.log("上传云端元数据失败:", error);
      return false;
    }
  }

  /**
   * Show first-time sync strategy dialog using native prompt
   * @returns "upload-all" | "download-all" | "merge" | "cancel"
   */
  private async showFirstSyncDialog(
    localCount: number,
    remoteCount: number,
  ): Promise<"upload-all" | "download-all" | "merge" | "cancel"> {
    ztoolkit.log("显示首次同步策略对话框（使用原生对话框）");

    const title = "首次同步到新存储桶";
    const text = `检测到这是首次同步到此存储桶。

本地有 ${localCount} 个文件，远程有 ${remoteCount} 个文件。

请选择同步策略：

⚠️ 重要提示：
• 上传到云端：会覆盖云端的同名文件
• 从云端下载：会覆盖本地的同名文件
• 合并：保留双方文件，但可能产生冲突`;

    const Services = Components.utils.import(
      "resource://gre/modules/Services.jsm"
    ).Services;

    const buttonFlags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;

    const win = Zotero.getMainWindow();
    const result = Services.prompt.confirmEx(
      win,
      title,
      text,
      buttonFlags,
      "合并（推荐）",
      "上传到云端",
      "从云端下载",
      null,
      {}
    );

    ztoolkit.log("用户选择结果:", result);

    switch (result) {
      case 0:
        ztoolkit.log("用户选择：合并");
        return "merge";
      case 1:
        ztoolkit.log("用户选择：上传到云端");
        return "upload-all";
      case 2:
        ztoolkit.log("用户选择：从云端下载");
        return "download-all";
      default:
        ztoolkit.log("用户取消或关闭对话框");
        return "cancel";
    }
  }

  /**
   * Compare local and remote files and determine sync operations
   */
  private async compareFilesAndDetermineSyncOperations(
    isIncremental: boolean,
  ): Promise<SyncOperations> {
    const operations: SyncOperations = {
      upload: [],
      download: [],
      conflicts: [],
      deleteLocal: [],
      deleteRemote: [],
      noChange: [],
    };

    // Get all local attachments
    const localFiles = new Map<
      string,
      { hash: string; filePath: string; modTime: number }
    >();
    let localAttachments = await this.getAllAttachments(isIncremental);
    if (isIncremental) {
      localAttachments = this.filterForIncrementalSync(localAttachments);
    }

    for (const attachment of localAttachments) {
      localFiles.set(attachment.attachmentKey, {
        hash: attachment.hash,
        filePath: attachment.filePath,
        modTime: attachment.modTime,
      });
    }

    // Get all remote files
    const prefix = (getPref("s3.prefix") as string) || "zotero-attachments";
    const remoteFiles = await this.s3Manager.listFilesWithMetadata(
      prefix,
      true,
    );
    const remoteFilesMap = new Map<string, S3FileMetadata>();

    ztoolkit.log(`获取到 ${remoteFiles.length} 个远程文件（prefix: ${prefix}）`);

    // If no files found with prefix, try listing all files to diagnose
    if (remoteFiles.length === 0) {
      ztoolkit.log(`使用 prefix="${prefix}" 未找到文件，尝试列出所有文件...`);
      const allFiles = await this.s3Manager.listFilesWithMetadata("");
      ztoolkit.log(`Bucket 中共有 ${allFiles.length} 个文件：`);
      for (let i = 0; i < Math.min(10, allFiles.length); i++) {
        ztoolkit.log(`  - ${allFiles[i].key}`);
      }
      if (allFiles.length > 10) {
        ztoolkit.log(`  ... 还有 ${allFiles.length - 10} 个文件`);
      }
    }

    for (const remoteFile of remoteFiles) {
      // Extract attachment key from S3 key (remove prefix)
      const attachmentKey = remoteFile.key.startsWith(`${prefix}/`)
        ? remoteFile.key.slice(prefix.length + 1)
        : remoteFile.key;

      // Skip metadata file
      if (attachmentKey === SyncManager.METADATA_FILE_KEY) {
        ztoolkit.log(`跳过元数据文件: ${remoteFile.key}`);
        continue;
      }

      remoteFilesMap.set(attachmentKey, remoteFile);
      ztoolkit.log(`远程文件: ${remoteFile.key} -> attachment key: ${attachmentKey}`);
    }

    ztoolkit.log(`本地文件数量: ${localFiles.size}, 远程文件数量: ${remoteFilesMap.size}`);

    // Get all metadata (last sync state)
    ztoolkit.log("正在获取元数据...");
    let allMetadata;
    try {
      allMetadata = this.metadataManager.getAllFileMetadata();
      ztoolkit.log(`元数据记录数量: ${Object.keys(allMetadata).length}`);
    } catch (error) {
      ztoolkit.log("获取元数据失败:", error);
      allMetadata = {};
    }

    // Combine all keys from local, remote, and metadata
    const allKeys = new Set([
      ...localFiles.keys(),
      ...remoteFilesMap.keys(),
      ...Object.keys(allMetadata),
    ]);

    ztoolkit.log(`=== 开始分析 ${allKeys.size} 个文件 ===`);

    // Analyze each file
    let processedCount = 0;
    for (const attachmentKey of allKeys) {
      processedCount++;
      ztoolkit.log(`[${processedCount}/${allKeys.size}] 正在分析: ${attachmentKey}`);

      const local = localFiles.get(attachmentKey);
      const remote = remoteFilesMap.get(attachmentKey);
      const metadata = allMetadata[attachmentKey];

      ztoolkit.log(`  - local存在: ${!!local}, remote存在: ${!!remote}, metadata存在: ${!!metadata}`);

      try {
        const operation = await this.determineOperation(
          attachmentKey,
          local,
          remote,
          metadata,
          this.hasCloudMetadata,
        );

        ztoolkit.log(`  - 决策结果: ${operation.type}`);

        // Categorize operation
        switch (operation.type) {
          case "upload":
            operations.upload.push(operation);
            break;
          case "download":
            operations.download.push(operation);
            break;
          case "conflict":
            operations.conflicts.push(operation);
            break;
          case "delete-local":
            operations.deleteLocal.push(operation);
            break;
          case "delete-remote":
            operations.deleteRemote.push(operation);
            break;
          case "no-change":
            operations.noChange.push(operation);
            break;
        }
      } catch (error) {
        ztoolkit.log(`  - 决策过程出错:`, error);
        // 出错时默认不操作
      }
    }

    ztoolkit.log("=== 文件分析完成 ===");

    // Check if this is first-time sync with data on both sides
    if (!this.hasCloudMetadata) {
      const hasLocalFiles = operations.upload.length > 0 || localFiles.size > 0;
      const hasRemoteFiles = operations.download.length > 0 || remoteFilesMap.size > 0;

      if (hasLocalFiles && hasRemoteFiles) {
        ztoolkit.log("检测到首次同步且本地和远程都有数据");
        ztoolkit.log(`  本地文件数: ${localFiles.size}`);
        ztoolkit.log(`  远程文件数: ${remoteFilesMap.size}`);

        // Store the detection result for use in syncAttachments
        // We'll handle the dialog there
        operations.conflicts.push({
          type: "conflict",
          attachmentKey: "__FIRST_SYNC_STRATEGY_NEEDED__",
          localHash: localFiles.size.toString(),
          remoteETag: remoteFilesMap.size.toString(),
        });
      }
    }

    return operations;
  }

  /**
   * Get all attachments from all libraries
   */
  private async getAllAttachments(isIncremental: boolean): Promise<SyncItem[]> {
    const items: SyncItem[] = [];

    try {
      const libraries = Zotero.Libraries.getAll();
      const lastFullSync = this.metadataManager.getLastFullSync();

      for (const library of libraries) {
        if (!library.filesEditable) {
          continue;
        }

        const libraryID = library.libraryID;
        const itemIDs = await Zotero.Items.getAll(
          libraryID,
          false,
          false,
          true,
        );

        for (const itemID of itemIDs) {
          const item = await Zotero.Items.getAsync(itemID);

          if (item && item.isAttachment() && item.isFileAttachment()) {
            const file = await item.getFilePathAsync();
            const lastSync = this.getLastSyncTime(item.key);

            if (file) {
              // File exists locally
              const modTime = await this.getFileModTime(file);
              const shouldHash =
                !isIncremental ||
                lastFullSync === 0 ||
                lastSync === 0 ||
                modTime === 0 ||
                modTime > lastFullSync;

              const hash = shouldHash
                ? await this.getFileHash(file)
                : this.getStoredHash(item.key) || (await this.getFileHash(file));

              items.push({
                itemID: item.id,
                attachmentKey: item.key,
                filePath: file,
                hash,
                lastSync,
                modTime,
              });
            } else {
              // File doesn't exist locally but item exists in Zotero
              // This could mean the file was deleted or never downloaded
              // We should check if it exists remotely and download it
              ztoolkit.log(`本地文件不存在，但 item 存在: ${item.key}`);
              items.push({
                itemID: item.id,
                attachmentKey: item.key,
                filePath: "", // Empty path indicates file doesn't exist
                hash: "", // Empty hash
                lastSync,
                modTime: 0,
              });
            }
          }
        }
      }
    } catch (error) {
      ztoolkit.log("Error getting attachments:", error);
    }

    return items;
  }

  /**
   * Check if incremental sync is enabled and conditions are met
   */
  private shouldUseIncrementalSync(): boolean {
    const incrementalEnabled = getPref("sync.incremental") as boolean;
    if (!incrementalEnabled) {
      return false;
    }

    // Check if we have a recent full sync
    const lastFullSync = this.metadataManager.getLastFullSync();
    if (lastFullSync === 0) {
      return false; // Never synced, must do full sync
    }

    // Only use incremental if last full sync was within a reasonable time
    // For example, within 7 days
    const daysSinceFullSync =
      (Date.now() - lastFullSync) / (1000 * 60 * 60 * 24);
    const maxDaysForIncremental =
      (getPref("sync.incrementalMaxDays") as number) || 7;

    return daysSinceFullSync < maxDaysForIncremental;
  }

  /**
   * Filter attachments for incremental sync
   */
  private filterForIncrementalSync(items: SyncItem[]): SyncItem[] {
    const lastFullSync = this.metadataManager.getLastFullSync();
    if (lastFullSync === 0) {
      return items;
    }

    return items.filter((item) => {
      // Always include missing files so we can recover from remote
      if (!item.filePath) {
        return true;
      }

      // Include if never synced or modified since last full sync
      if (item.lastSync === 0) {
        return true;
      }

      return item.modTime === 0 || item.modTime > lastFullSync;
    });
  }

  /**
   * Three-way merge decision engine
   * Determines what operation to perform based on local, remote, and last sync state
   * @param hasCloudMetadata - Whether cloud has sync metadata (false for new/empty buckets)
   */
  private async determineOperation(
    attachmentKey: string,
    local: { hash: string; filePath: string; modTime: number } | undefined,
    remote: S3FileMetadata | undefined,
    metadata: any,
    hasCloudMetadata: boolean,
  ): Promise<SyncOperation> {
    const lastSyncHash = metadata?.lastSyncHash;
    const lastSyncTime = metadata?.lastSyncTime || 0;

    // Case 1: File doesn't exist anywhere (should not happen, but handle it)
    if (!local && !remote && !metadata) {
      return {
        type: "no-change",
        attachmentKey,
      };
    }

    // Case 2: File exists locally and remotely
    if (local && remote) {
      // Debug logging
      ztoolkit.log(`[决策分析] ${attachmentKey}:`);
      ztoolkit.log(`  本地 hash: ${local.hash}`);
      ztoolkit.log(`  远程 metaMd5: ${remote.metaMd5 || '(无)'}`);
      ztoolkit.log(`  远程 etag: ${remote.etag}`);
      ztoolkit.log(`  上次同步 hash: ${lastSyncHash || '(无)'}`);
      ztoolkit.log(`  远程大小: ${remote.size}`);

      // Special case: Local file doesn't exist (empty hash) but item exists
      // This means the file was deleted or never downloaded - should download
      if (local.hash === "") {
        ztoolkit.log(
          `本地文件不存在但 item 存在，需要从远程下载: ${attachmentKey}`,
        );
        return {
          type: "download",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remote.etag,
          remoteModTime: remote.lastModified,
          filePath: local.filePath,
        };
      }

      // First sync: no lastSyncHash available
      if (!lastSyncHash) {
        ztoolkit.log(`  首次同步，没有 lastSyncHash`);
        const remoteHash = remote.metaMd5 || remote.etag;
        // Compare local and remote directly
        if (local.hash === remoteHash) {
          // Files are identical, record as synced
          ztoolkit.log(`  本地 hash 与远程 hash 相同，标记为无变化`);
          return {
            type: "no-change",
            attachmentKey,
            localHash: local.hash,
            remoteETag: remoteHash,
            filePath: local.filePath,
            remoteModTime: remote.lastModified,
          };
        }

        // Files are different on first sync
        // If remote hash is unreliable (no metaMd5) but size matches, assume no-change to avoid redundant downloads
        if (!remote.metaMd5 && remote.size > 0 && local.filePath) {
          const localSize = await this.getFileSize(local.filePath);
          ztoolkit.log(`  本地大小: ${localSize}, 远程大小: ${remote.size}`);
          if (localSize === remote.size) {
            ztoolkit.log(`  没有 metaMd5 但大小相同，标记为无变化`);
            return {
              type: "no-change",
              attachmentKey,
              localHash: local.hash,
              remoteETag: remoteHash,
              filePath: local.filePath,
              remoteModTime: remote.lastModified,
            };
          }
        }

        // Default behavior: use local (upload) as it's likely more recent
        // Or use modification time to decide when hashes differ
        if (local.modTime >= remote.lastModified) {
          ztoolkit.log(`  本地修改时间较新，标记为上传`);
          return {
            type: "upload",
            attachmentKey,
            localHash: local.hash,
            remoteETag: remoteHash,
            filePath: local.filePath,
          };
        }

        ztoolkit.log(`  远程修改时间较新，标记为下载`);
        return {
          type: "download",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remoteHash,
          filePath: local.filePath,
        };
      }

      // Subsequent syncs: compare with lastSyncHash
      const remoteHash = remote.metaMd5 || remote.etag;
      const localChanged = local.hash !== lastSyncHash;
      // If we have a stored sync hash but remote has no reliable checksum, trust local state
      if (!remote.metaMd5 && lastSyncHash && local.hash === lastSyncHash) {
        return {
          type: "no-change",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remoteHash,
          filePath: local.filePath,
          remoteModTime: remote.lastModified,
        };
      }
      // If remote hash is unreliable (no metaMd5), assume remote unchanged unless meta is present
      const remoteChanged = remote.metaMd5
        ? remoteHash !== lastSyncHash
        : false;

      // Both unchanged
      if (!localChanged && !remoteChanged) {
        return {
          type: "no-change",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remoteHash,
          filePath: local.filePath,
          remoteModTime: remote.lastModified,
        };
      }

      // Only local changed
      if (localChanged && !remoteChanged) {
        return {
          type: "upload",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remoteHash,
          lastSyncHash,
          filePath: local.filePath,
        };
      }

      // Only remote changed
      if (!localChanged && remoteChanged) {
        return {
          type: "download",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remoteHash,
          lastSyncHash,
          filePath: local.filePath,
        };
      }

      // Both changed - conflict!
      return {
        type: "conflict",
        attachmentKey,
        localHash: local.hash,
        remoteETag: remoteHash,
        localModTime: local.modTime,
        remoteModTime: remote.lastModified,
        lastSyncHash,
        filePath: local.filePath,
      };
    }

    // Case 3: File exists only locally
    if (local && !remote) {
      // Special case: Item exists but file doesn't (empty hash/path)
      // Without remote file, there's nothing to download and nothing to upload
      if (local.hash === "") {
        ztoolkit.log(
          `本地文件不存在且远程也不存在: ${attachmentKey}，跳过`,
        );
        return {
          type: "no-change",
          attachmentKey,
        };
      }

      // Check if cloud has any sync records
      if (!hasCloudMetadata) {
        // New bucket or first sync - upload local file
        ztoolkit.log(
          `云端无同步记录，本地文件需要上传: ${attachmentKey}`,
        );
        return {
          type: "upload",
          attachmentKey,
          localHash: local.hash,
          filePath: local.filePath,
        };
      }

      // Cloud has metadata - check if file was synced before
      if (!metadata || lastSyncTime === 0) {
        // Never synced before - upload
        return {
          type: "upload",
          attachmentKey,
          localHash: local.hash,
          filePath: local.filePath,
        };
      }

      // Was synced before but deleted remotely - delete local
      ztoolkit.log(
        `文件曾同步过但已从云端删除: ${attachmentKey}，删除本地`,
      );
      return {
        type: "delete-local",
        attachmentKey,
        localHash: local.hash,
        lastSyncHash,
        filePath: local.filePath,
      };
    }

    // Case 4: File exists only remotely
    if (!local && remote) {
      // Check if cloud has any sync records
      if (!hasCloudMetadata) {
        // New bucket - this shouldn't happen, but download anyway
        ztoolkit.log(
          `云端无同步记录但存在远程文件，下载: ${attachmentKey}`,
        );
        return {
          type: "download",
          attachmentKey,
          remoteETag: remote.etag,
          remoteModTime: remote.lastModified,
        };
      }

      // Cloud has metadata - check if file was synced before
      if (!metadata || lastSyncTime === 0) {
        // Never synced before or new file on remote - download
        return {
          type: "download",
          attachmentKey,
          remoteETag: remote.etag,
          remoteModTime: remote.lastModified,
        };
      }

      // Was synced before but deleted locally - delete remote
      ztoolkit.log(
        `文件曾同步过但已从本地删除: ${attachmentKey}，删除远程`,
      );
      return {
        type: "delete-remote",
        attachmentKey,
        remoteETag: remote.etag,
        lastSyncHash,
      };
    }

    // Case 5: File doesn't exist locally or remotely, but has metadata
    // This means it was deleted from both sides - clean up metadata
    if (!local && !remote && metadata) {
      return {
        type: "no-change", // Will clean up metadata
        attachmentKey,
      };
    }

    // Default: no change
    return {
      type: "no-change",
      attachmentKey,
    };
  }

  /**
   * Execute download operation for a single file
   */
  private async executeDownload(operation: SyncOperation): Promise<boolean> {
    try {
      const s3Key = this.getS3Key(operation.attachmentKey);
      const blob = await this.s3Manager.downloadFile(s3Key);

      if (!blob) {
        ztoolkit.log(
          `Failed to download ${operation.attachmentKey}: blob is null`,
        );
        return false;
      }

      // Get or create the attachment item
      const item = await this.getOrCreateAttachmentItem(
        operation.attachmentKey,
      );
      if (!item) {
        ztoolkit.log(
          `Failed to get or create attachment item for ${operation.attachmentKey}`,
        );
        return false;
      }

      // Get file path
      let filePath = operation.filePath;
      if (!filePath) {
        // Try to get existing file path
        filePath = await item.getFilePathAsync();
      }

      if (!filePath) {
        // File doesn't exist, construct the expected path
        // Zotero storage path: {dataDir}/storage/{attachmentKey}/{filename}
        const storageDir = Zotero.DataDirectory.dir;
        const attachmentDir = PathUtils.join(
          storageDir,
          "storage",
          operation.attachmentKey,
        );

        // Get filename from attachment
        const filename = item.attachmentFilename;
        if (!filename) {
          ztoolkit.log(
            `No filename for attachment ${operation.attachmentKey}`,
          );
          return false;
        }

        filePath = PathUtils.join(attachmentDir, filename);
        ztoolkit.log(
          `构建文件路径: ${filePath} (文件名: ${filename})`,
        );

        // Ensure directory exists
        try {
          await IOUtils.makeDirectory(attachmentDir, { ignoreExisting: true });
          ztoolkit.log(`创建目录: ${attachmentDir}`);
        } catch (error) {
          ztoolkit.log(`Failed to create directory ${attachmentDir}:`, error);
          return false;
        }
      }

      // Write blob to file
      await this.writeBlobToFile(blob, filePath);

      // Update metadata
      const hash = await this.getFileHash(filePath);
      const localMtime = await this.getFileModTime(filePath);
      const fileSize = await this.getFileSize(filePath);

      this.metadataManager.recordSync(
        operation.attachmentKey,
        hash,
        localMtime,
        operation.remoteModTime || Date.now(),
        fileSize,
      );

      ztoolkit.log(`Successfully downloaded ${operation.attachmentKey}`);
      return true;
    } catch (error) {
      ztoolkit.log(`Error downloading ${operation.attachmentKey}:`, error);
      return false;
    }
  }

  /**
   * Execute upload operation for a single file
   */
  private async executeUpload(operation: SyncOperation): Promise<boolean> {
    try {
      if (!operation.filePath) {
        ztoolkit.log(`No file path for upload: ${operation.attachmentKey}`);
        return false;
      }

      const s3Key = this.getS3Key(operation.attachmentKey);
      const blob = await this.readFileAsBlob(operation.filePath);

      if (!blob) {
        ztoolkit.log(`Failed to read file: ${operation.filePath}`);
        return false;
      }

      const hash = await this.getFileHash(operation.filePath);
      const success = await this.s3Manager.uploadFile(
        blob,
        s3Key,
        undefined,
        hash,
      );

      if (success) {
        // Update metadata
        const localMtime = await this.getFileModTime(operation.filePath);
        const remoteMtime = await this.s3Manager.getFileModTime(s3Key);
        const fileSize = await this.getFileSize(operation.filePath);

        this.metadataManager.recordSync(
          operation.attachmentKey,
          hash,
          localMtime,
          remoteMtime,
          fileSize,
        );

        ztoolkit.log(`Successfully uploaded ${operation.attachmentKey}`);
      }

      return success;
    } catch (error) {
      ztoolkit.log(`Error uploading ${operation.attachmentKey}:`, error);
      return false;
    }
  }

  /**
   * Get attachment item by key, or return null if not found
   */
  private async getOrCreateAttachmentItem(attachmentKey: string): Promise<any> {
    try {
      // Try to get existing item
      const libraries = Zotero.Libraries.getAll();

      for (const library of libraries) {
        const item = Zotero.Items.getByLibraryAndKey(
          library.libraryID,
          attachmentKey,
        );
        if (item) {
          return item;
        }
      }

      // Item not found - this means it's a remote file that doesn't exist locally
      // For now, we skip creating new items as this requires more context
      // (parent item, collection, etc.)
      ztoolkit.log(`Attachment item not found for key: ${attachmentKey}`);
      return null;
    } catch (error) {
      ztoolkit.log(`Error getting attachment item: ${attachmentKey}`, error);
      return null;
    }
  }

  /**
   * Resolve conflicts based on strategy
   */
  private async resolveConflicts(
    conflicts: SyncOperation[],
    strategy?: ConflictResolutionStrategy,
  ): Promise<{
    upload: SyncOperation[];
    download: SyncOperation[];
    skip: SyncOperation[];
  }> {
    const result = {
      upload: [] as SyncOperation[],
      download: [] as SyncOperation[],
      skip: [] as SyncOperation[],
    };

    // Get strategy from preferences or use provided one
    const conflictStrategy =
      strategy ||
      (getPref("conflictResolution") as ConflictResolutionStrategy) ||
      "ask";

    if (conflictStrategy === "ask") {
      // Show dialog for each conflict or ask for global strategy
      const resolution = await this.showConflictDialog(conflicts.length);

      if (resolution === "cancel") {
        result.skip = conflicts;
        return result;
      }

      // Apply resolution to all conflicts
      for (const conflict of conflicts) {
        if (resolution === "upload") {
          result.upload.push(conflict);
        } else if (resolution === "download") {
          result.download.push(conflict);
        }
      }
    } else {
      // Auto-resolve based on strategy
      for (const conflict of conflicts) {
        const resolution = this.autoResolveConflict(conflict, conflictStrategy);

        if (resolution === "upload") {
          result.upload.push(conflict);
        } else if (resolution === "download") {
          result.download.push(conflict);
        } else {
          result.skip.push(conflict);
        }
      }
    }

    return result;
  }

  /**
   * Auto-resolve conflict based on strategy
   */
  private autoResolveConflict(
    conflict: SyncOperation,
    strategy: ConflictResolutionStrategy,
  ): "upload" | "download" | "skip" {
    switch (strategy) {
      case "local-wins":
        return "upload";

      case "remote-wins":
        return "download";

      case "newer-wins":
        // Compare modification times
        if (conflict.localModTime && conflict.remoteModTime) {
          return conflict.localModTime > conflict.remoteModTime
            ? "upload"
            : "download";
        }
        // Fallback to local if no timestamps
        return "upload";

      default:
        return "skip";
    }
  }

  /**
   * Execute delete local operation
   */
  private async executeDeleteLocal(operation: SyncOperation): Promise<boolean> {
    try {
      if (!operation.filePath) {
        ztoolkit.log(
          `No file path for delete-local: ${operation.attachmentKey}`,
        );
        return false;
      }

      // Get attachment item
      const item = await this.getOrCreateAttachmentItem(
        operation.attachmentKey,
      );
      if (!item) {
        ztoolkit.log(`Attachment item not found: ${operation.attachmentKey}`);
        return false;
      }

      // Delete the file
      const file = Zotero.File.pathToFile(operation.filePath);
      if (file.exists()) {
        file.remove(false);
        ztoolkit.log(`Deleted local file: ${operation.filePath}`);
      }

      // Optionally delete the attachment item (or just mark as missing)
      // For now, we'll just delete the file and let Zotero handle the missing file

      // Remove metadata
      this.metadataManager.removeFileMetadata(operation.attachmentKey);

      return true;
    } catch (error) {
      ztoolkit.log(
        `Error deleting local file ${operation.attachmentKey}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Execute delete remote operation
   */
  private async executeDeleteRemote(
    operation: SyncOperation,
  ): Promise<boolean> {
    try {
      const s3Key = this.getS3Key(operation.attachmentKey);
      const success = await this.s3Manager.deleteFile(s3Key);

      if (success) {
        // Remove metadata
        this.metadataManager.removeFileMetadata(operation.attachmentKey);
        ztoolkit.log(`Deleted remote file: ${s3Key}`);
      }

      return success;
    } catch (error) {
      ztoolkit.log(
        `Error deleting remote file ${operation.attachmentKey}:`,
        error,
      );
      return false;
    }
  }

  public async syncAttachments(): Promise<void> {
    ztoolkit.log("=== syncAttachments 开始执行 ===");
    ztoolkit.log("代码版本: 0.1.27");

    if (this.isSyncing) {
      ztoolkit.log("Sync already in progress");
      return;
    }

    // Reload S3 configuration in case it was changed
    this.s3Manager.reloadConfig();

    if (!this.s3Manager.isConfigured()) {
      ztoolkit.log("S3 not configured, cannot sync");
      new ztoolkit.ProgressWindow("S3 Sync", { closeOnClick: true })
        .createLine({
          text: "S3 not configured. Please check settings.",
          type: "error",
        })
        .show();
      return;
    }

    this.isSyncing = true;

    const isIncremental = this.shouldUseIncrementalSync();
    const syncType = isIncremental ? "增量同步" : "完整同步";

    const progressWindow = new ztoolkit.ProgressWindow(
      `S3 云同步 - ${syncType}`,
    )
      .createLine({
        text: "正在下载云端同步记录...",
        type: "default",
        progress: 0,
      })
      .show();

    try {
      // Download cloud metadata first
      progressWindow.changeLine({
        text: "正在下载云端同步记录...",
        type: "default",
        progress: 3,
      });

      await this.downloadCloudMetadata();

      // Analyze local and remote files
      progressWindow.changeLine({
        text: "正在分析文件差异...",
        type: "default",
        progress: 5,
      });

      const operations = await this.compareFilesAndDetermineSyncOperations(
        isIncremental,
      );

      const totalOperations =
        operations.upload.length +
        operations.download.length +
        operations.conflicts.length +
        operations.deleteLocal.length +
        operations.deleteRemote.length;

      ztoolkit.log(`同步分析完成:
        上传: ${operations.upload.length}
        下载: ${operations.download.length}
        冲突: ${operations.conflicts.length}
        删除本地: ${operations.deleteLocal.length}
        删除远程: ${operations.deleteRemote.length}
        无变化: ${operations.noChange.length}`);

      if (totalOperations === 0) {
        progressWindow.changeLine({
          text: "所有文件已同步",
          type: "success",
          progress: 100,
        });
        progressWindow.startCloseTimer(3000);

        // Update last full sync time
        if (!isIncremental) {
          this.metadataManager.updateLastFullSync();
        }

        this.isSyncing = false;
        return;
      }

      // Check for first-time sync scenario
      const firstSyncMarker = operations.conflicts.find(
        (c) => c.attachmentKey === "__FIRST_SYNC_STRATEGY_NEEDED__",
      );

      if (firstSyncMarker) {
        // Remove the marker from conflicts
        operations.conflicts = operations.conflicts.filter(
          (c) => c.attachmentKey !== "__FIRST_SYNC_STRATEGY_NEEDED__",
        );

        const localCount = parseInt(firstSyncMarker.localHash || "0");
        const remoteCount = parseInt(firstSyncMarker.remoteETag || "0");

        // 显示提示，使用原生对话框（不需要关闭进度窗口）
        progressWindow.changeLine({
          text: "首次同步到新存储桶，请选择同步策略...",
          type: "default",
          progress: 10,
        });

        const strategy = await this.showFirstSyncDialog(localCount, remoteCount);

        ztoolkit.log("策略对话框返回结果:", strategy);

        if (strategy === "cancel") {
          ztoolkit.log("用户取消同步");
          progressWindow.changeLine({
            text: "用户取消同步",
            type: "default",
            progress: 0,
          });
          progressWindow.startCloseTimer(2000);
          this.isSyncing = false;
          return;
        }

        // 用户选择了策略，继续同步
        progressWindow.changeLine({
          text: `已选择策略，开始同步...`,
          type: "default",
          progress: 15,
        });

        if (strategy === "upload-all") {
          // Upload local, don't download remote
          ztoolkit.log("用户选择：上传到云端");
          operations.download = [];
          operations.deleteRemote = [];
        } else if (strategy === "download-all") {
          // Download remote, don't upload local
          ztoolkit.log("用户选择：从云端下载");
          operations.upload = [];
          operations.deleteLocal = [];
        } else if (strategy === "merge") {
          // Keep both upload and download (default behavior)
          ztoolkit.log("用户选择：合并");
          // No changes needed
        }
      }

      // Handle conflicts
      let resolvedConflicts = {
        upload: [] as SyncOperation[],
        download: [] as SyncOperation[],
        skip: [] as SyncOperation[],
      };
      if (operations.conflicts.length > 0) {
        progressWindow.changeLine({
          text: `发现 ${operations.conflicts.length} 个冲突，请选择处理方式...`,
          type: "default",
          progress: 10,
        });

        resolvedConflicts = await this.resolveConflicts(operations.conflicts);

        if (resolvedConflicts.skip.length === operations.conflicts.length) {
          // User cancelled
          ztoolkit.log("用户取消同步");
          progressWindow.changeLine({
            text: "用户取消同步",
            type: "default",
            progress: 0,
          });
          progressWindow.startCloseTimer(2000);
          this.isSyncing = false;
          return;
        }

        // 继续同步
        progressWindow.changeLine({
          text: `冲突已解决，开始同步...`,
          type: "default",
          progress: 15,
        });

        // Add resolved conflicts to respective operation lists
        operations.upload.push(...resolvedConflicts.upload);
        operations.download.push(...resolvedConflicts.download);
      }

      // Execute operations
      let completed = 0;
      let failed = 0;
      const totalToSync =
        operations.upload.length +
        operations.download.length +
        operations.deleteLocal.length +
        operations.deleteRemote.length;

      // Get concurrency setting from preferences
      const concurrency =
        (getPref("sync.concurrency") as number) ||
        SyncManager.DEFAULT_CONCURRENCY;

      ztoolkit.log(`使用并发数: ${concurrency}`);

      // Execute uploads concurrently
      if (operations.upload.length > 0) {
        progressWindow.changeLine({
          text: `正在上传 ${operations.upload.length} 个文件...`,
          type: "default",
          progress: 15,
        });

        const uploadResults = await this.executeConcurrently(
          operations.upload,
          (op) => this.executeUpload(op),
          (current, total, op) => {
            progressWindow.changeLine({
              text: `上传: ${op.attachmentKey} (${current}/${total})`,
              type: "default",
              progress: 15 + (current / totalToSync) * 35,
            });
          },
          concurrency,
        );

        completed += uploadResults.completed;
        failed += uploadResults.failed;
      }

      // Execute downloads concurrently
      if (operations.download.length > 0) {
        progressWindow.changeLine({
          text: `正在下载 ${operations.download.length} 个文件...`,
          type: "default",
          progress: 15 + (completed / totalToSync) * 35,
        });

        const downloadResults = await this.executeConcurrently(
          operations.download,
          (op) => this.executeDownload(op),
          (current, total, op) => {
            progressWindow.changeLine({
              text: `下载: ${op.attachmentKey} (${current}/${total})`,
              type: "default",
              progress: 15 + ((completed + current) / totalToSync) * 35,
            });
          },
          concurrency,
        );

        completed += downloadResults.completed;
        failed += downloadResults.failed;
      }

      // Execute local deletes (usually fast, keep serial)
      for (const op of operations.deleteLocal) {
        progressWindow.changeLine({
          text: `删除本地: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 50 + (completed / totalToSync) * 20,
        });

        const success = await this.executeDeleteLocal(op);
        if (success) {
          completed++;
        } else {
          failed++;
        }
      }

      // Execute remote deletes (usually fast, keep serial)
      for (const op of operations.deleteRemote) {
        progressWindow.changeLine({
          text: `删除远程: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 70 + (completed / totalToSync) * 15,
        });

        const success = await this.executeDeleteRemote(op);
        if (success) {
          completed++;
        } else {
          failed++;
        }
      }

      // Update metadata for no-change files (to avoid re-checking next time)
      for (const op of operations.noChange) {
        if (op.localHash && op.remoteETag) {
          // Record that these files are in sync
          const metadata = this.metadataManager.getFileMetadata(
            op.attachmentKey,
          );
          if (!metadata || !metadata.lastSyncHash) {
            // First time detecting this file is synced, record it
            // Get file information
            let localMtime = 0;
            let fileSize = 0;
            if (op.filePath) {
              localMtime = await this.getFileModTime(op.filePath);
              fileSize = await this.getFileSize(op.filePath);
            }

            this.metadataManager.recordSync(
              op.attachmentKey,
              op.localHash,
              localMtime,
              op.remoteModTime || Date.now(),
              fileSize,
            );
          }
        }
      }

      // Update last full sync time
      if (!isIncremental) {
        this.metadataManager.updateLastFullSync();
      }

      // Upload metadata to cloud
      progressWindow.changeLine({
        text: "正在上传同步记录到云端...",
        type: "default",
        progress: 95,
      });

      await this.uploadCloudMetadata();

      // Clear sync status
      addon.data.syncStatus = { isSyncing: false };
      this.updateToolbarTooltip("S3 云同步");

      progressWindow.changeLine({
        text: `同步完成: ${completed} 成功, ${failed} 失败`,
        type: failed > 0 ? "default" : "success",
        progress: 100,
      });
      progressWindow.startCloseTimer(5000);
    } catch (error) {
      ztoolkit.log("Sync error:", error);
      progressWindow.changeLine({
        text: `同步失败: ${error}`,
        type: "error",
        progress: 0,
      });
      progressWindow.startCloseTimer(5000);
    } finally {
      this.isSyncing = false;
    }
  }

  private async updateSyncRecord(item: SyncItem): Promise<void> {
    const localMtime = await this.getFileModTime(item.filePath);
    const s3Key = this.getS3Key(item.attachmentKey);
    const remoteMtime = await this.s3Manager.getFileModTime(s3Key);
    const fileSize = await this.getFileSize(item.filePath);

    this.metadataManager.recordSync(
      item.attachmentKey,
      item.hash,
      localMtime,
      remoteMtime,
      fileSize,
    );
  }

  private getLastSyncTime(attachmentKey: string): number {
    const metadata = this.metadataManager.getFileMetadata(attachmentKey);
    return metadata?.lastSyncTime || 0;
  }

  private getStoredHash(attachmentKey: string): string {
    const metadata = this.metadataManager.getFileMetadata(attachmentKey);
    return metadata?.hash || "";
  }

  private getS3Key(attachmentKey: string): string {
    const prefix = (getPref("s3.prefix") as string) || "zotero-attachments";
    return `${prefix}/${attachmentKey}`;
  }

  private async getFileHash(filePath: string): Promise<string> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      // @ts-expect-error - Zotero XPCOM types
      const stream = Components.classes[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Components.interfaces.nsIFileInputStream);
      stream.init(file, -1, 0, 0);

      // @ts-expect-error - Zotero XPCOM types
      const hash = Components.classes[
        "@mozilla.org/security/hash;1"
      ].createInstance(Components.interfaces.nsICryptoHash);
      hash.init(hash.MD5);
      hash.updateFromStream(stream, stream.available());

      const hashBytes = hash.finish(false);
      const hashString = Array.from(hashBytes, (byte: number) =>
        ("0" + (byte & 0xff).toString(16)).slice(-2),
      ).join("");

      stream.close();
      return hashString;
    } catch (error) {
      ztoolkit.log(`Error computing hash for ${filePath}:`, error);
      return "";
    }
  }

  private async getFileModTime(filePath: string): Promise<number> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      return file.lastModifiedTime;
    } catch (error) {
      return 0;
    }
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      return file.fileSize || 0;
    } catch (error) {
      return 0;
    }
  }

  private async readFileAsBlob(filePath: string): Promise<Blob | null> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      // @ts-expect-error - Zotero XPCOM types
      const stream = Components.classes[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Components.interfaces.nsIFileInputStream);
      stream.init(file, -1, 0, 0);

      // @ts-expect-error - Zotero XPCOM types
      const binaryStream = Components.classes[
        "@mozilla.org/binaryinputstream;1"
      ].createInstance(Components.interfaces.nsIBinaryInputStream);
      binaryStream.setInputStream(stream);

      const bytes = binaryStream.readBytes(binaryStream.available());
      binaryStream.close();
      stream.close();

      const uint8Array = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        uint8Array[i] = bytes.charCodeAt(i) & 0xff;
      }

      return new Blob([uint8Array]);
    } catch (error) {
      ztoolkit.log(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  public async downloadAttachment(attachmentKey: string): Promise<boolean> {
    const s3Key = this.getS3Key(attachmentKey);

    try {
      const blob = await this.s3Manager.downloadFile(s3Key);
      if (!blob) {
        return false;
      }

      // Get the Zotero item
      const item = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        attachmentKey,
      );
      if (!item) {
        return false;
      }

      const filePath = await item.getFilePathAsync();
      if (!filePath) {
        return false;
      }

      // Write blob to file
      await this.writeBlobToFile(blob, filePath);
      return true;
    } catch (error) {
      ztoolkit.log(`Error downloading attachment ${attachmentKey}:`, error);
      return false;
    }
  }

  private async writeBlobToFile(blob: Blob, filePath: string): Promise<void> {
    const file = Zotero.File.pathToFile(filePath);
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // @ts-expect-error - Zotero XPCOM types
    const stream = Components.classes[
      "@mozilla.org/network/file-output-stream;1"
    ].createInstance(Components.interfaces.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);

    // @ts-expect-error - Zotero XPCOM types
    const binaryStream = Components.classes[
      "@mozilla.org/binaryoutputstream;1"
    ].createInstance(Components.interfaces.nsIBinaryOutputStream);
    binaryStream.setOutputStream(stream);

    binaryStream.writeByteArray(Array.from(uint8Array), uint8Array.length);
    binaryStream.close();
    stream.close();
  }

  private async showConflictDialog(
    conflictCount: number,
  ): Promise<"upload" | "download" | "cancel"> {
    ztoolkit.log(`显示冲突解决对话框（使用原生对话框），冲突数量：${conflictCount}`);

    const title = "同步冲突";
    const text = `发现 ${conflictCount} 个文件在云端和本地都有修改。

请选择如何处理：`;

    const Services = Components.utils.import(
      "resource://gre/modules/Services.jsm"
    ).Services;

    const buttonFlags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;

    const win = Zotero.getMainWindow();
    const result = Services.prompt.confirmEx(
      win,
      title,
      text,
      buttonFlags,
      "使用本地覆盖云端",
      "使用云端覆盖本地",
      "取消同步",
      null,
      {}
    );

    ztoolkit.log("用户选择结果:", result);

    switch (result) {
      case 0:
        ztoolkit.log("用户选择：使用本地覆盖云端");
        return "upload";
      case 1:
        ztoolkit.log("用户选择：使用云端覆盖本地");
        return "download";
      case 2:
      default:
        ztoolkit.log("用户取消或关闭对话框");
        return "cancel";
    }
  }

  private updateToolbarTooltip(text: string): void {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return;

      const button = win.document.querySelector(
        "#zotero-tb-s3sync",
      ) as XUL.Element;
      if (button) {
        button.setAttribute("tooltiptext", text);
      }
    } catch (error) {
      // Ignore errors if button doesn't exist
    }
  }
}
