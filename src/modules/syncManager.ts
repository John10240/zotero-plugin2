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

  constructor() {
    this.s3Manager = new S3Manager();
    this.metadataManager = new SyncMetadataManager();
  }

  /**
   * Compare local and remote files and determine sync operations
   */
  private async compareFilesAndDetermineSyncOperations(): Promise<SyncOperations> {
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
    const localAttachments = await this.getAllAttachments();

    for (const attachment of localAttachments) {
      localFiles.set(attachment.attachmentKey, {
        hash: attachment.hash,
        filePath: attachment.filePath,
        modTime: await this.getFileModTime(attachment.filePath),
      });
    }

    // Get all remote files
    const prefix = (getPref("s3.prefix") as string) || "zotero-attachments";
    const remoteFiles = await this.s3Manager.listFilesWithMetadata(prefix);
    const remoteFilesMap = new Map<string, S3FileMetadata>();

    for (const remoteFile of remoteFiles) {
      // Extract attachment key from S3 key (remove prefix)
      const attachmentKey = remoteFile.key.replace(`${prefix}/`, "");
      remoteFilesMap.set(attachmentKey, remoteFile);
    }

    // Get all metadata (last sync state)
    const allMetadata = this.metadataManager.getAllFileMetadata();

    // Combine all keys from local, remote, and metadata
    const allKeys = new Set([
      ...localFiles.keys(),
      ...remoteFilesMap.keys(),
      ...Object.keys(allMetadata),
    ]);

    // Analyze each file
    for (const attachmentKey of allKeys) {
      const local = localFiles.get(attachmentKey);
      const remote = remoteFilesMap.get(attachmentKey);
      const metadata = allMetadata[attachmentKey];

      const operation = this.determineOperation(
        attachmentKey,
        local,
        remote,
        metadata,
      );

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
    }

    return operations;
  }

  /**
   * Get all attachments from all libraries
   */
  private async getAllAttachments(): Promise<SyncItem[]> {
    const items: SyncItem[] = [];

    try {
      const libraries = Zotero.Libraries.getAll();

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

            if (file) {
              const hash = await this.getFileHash(file);
              items.push({
                itemID: item.id,
                attachmentKey: item.key,
                filePath: file,
                hash: hash,
                lastSync: this.getLastSyncTime(item.key),
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

    return items.filter((item) => {
      // Include if never synced
      if (item.lastSync === 0) {
        return true;
      }

      // Include if modified since last full sync
      // We'll check the file modification time
      return true; // For now, include all in the comparison logic
      // The three-way merge will determine what actually needs syncing
    });
  }

  /**
   * Three-way merge decision engine
   * Determines what operation to perform based on local, remote, and last sync state
   */
  private determineOperation(
    attachmentKey: string,
    local: { hash: string; filePath: string; modTime: number } | undefined,
    remote: S3FileMetadata | undefined,
    metadata: any,
  ): SyncOperation {
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
      // First sync: no lastSyncHash available
      if (!lastSyncHash) {
        // Compare local and remote directly
        if (local.hash === remote.etag) {
          // Files are identical, record as synced
          return {
            type: "no-change",
            attachmentKey,
            localHash: local.hash,
            remoteETag: remote.etag,
          };
        }

        // Files are different on first sync
        // Default behavior: use local (upload) as it's likely more recent
        // Or could use modification time to decide
        if (local.modTime > remote.lastModified) {
          return {
            type: "upload",
            attachmentKey,
            localHash: local.hash,
            remoteETag: remote.etag,
            filePath: local.filePath,
          };
        } else {
          return {
            type: "download",
            attachmentKey,
            localHash: local.hash,
            remoteETag: remote.etag,
            filePath: local.filePath,
          };
        }
      }

      // Subsequent syncs: compare with lastSyncHash
      const localChanged = local.hash !== lastSyncHash;
      const remoteChanged = remote.etag !== lastSyncHash;

      // Both unchanged
      if (!localChanged && !remoteChanged) {
        return {
          type: "no-change",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remote.etag,
        };
      }

      // Only local changed
      if (localChanged && !remoteChanged) {
        return {
          type: "upload",
          attachmentKey,
          localHash: local.hash,
          remoteETag: remote.etag,
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
          remoteETag: remote.etag,
          lastSyncHash,
          filePath: local.filePath,
        };
      }

      // Both changed - conflict!
      return {
        type: "conflict",
        attachmentKey,
        localHash: local.hash,
        remoteETag: remote.etag,
        localModTime: local.modTime,
        remoteModTime: remote.lastModified,
        lastSyncHash,
        filePath: local.filePath,
      };
    }

    // Case 3: File exists only locally
    if (local && !remote) {
      // Never synced before - upload
      if (!metadata || lastSyncTime === 0) {
        return {
          type: "upload",
          attachmentKey,
          localHash: local.hash,
          filePath: local.filePath,
        };
      }

      // Was synced before but deleted remotely - delete local
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
      // Never synced before or new file on remote - download
      if (!metadata || lastSyncTime === 0) {
        return {
          type: "download",
          attachmentKey,
          remoteETag: remote.etag,
          remoteModTime: remote.lastModified,
        };
      }

      // Was synced before but deleted locally - delete remote
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
        filePath = await item.getFilePathAsync();
      }

      if (!filePath) {
        ztoolkit.log(`No file path for ${operation.attachmentKey}`);
        return false;
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

      const success = await this.s3Manager.uploadFile(blob, s3Key);

      if (success) {
        // Update metadata
        const hash = await this.getFileHash(operation.filePath);
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
        text: "正在分析本地和远程文件...",
        type: "default",
        progress: 0,
      })
      .show();

    try {
      // Analyze local and remote files
      progressWindow.changeLine({
        text: "正在分析文件差异...",
        type: "default",
        progress: 5,
      });

      const operations = await this.compareFilesAndDetermineSyncOperations();

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

      // Handle conflicts
      let resolvedConflicts = {
        upload: [] as SyncOperation[],
        download: [] as SyncOperation[],
        skip: [] as SyncOperation[],
      };
      if (operations.conflicts.length > 0) {
        progressWindow.changeLine({
          text: `发现 ${operations.conflicts.length} 个冲突，正在解决...`,
          type: "default",
          progress: 10,
        });

        resolvedConflicts = await this.resolveConflicts(operations.conflicts);

        if (resolvedConflicts.skip.length === operations.conflicts.length) {
          // User cancelled
          progressWindow.changeLine({
            text: "用户取消同步",
            type: "default",
            progress: 0,
          });
          progressWindow.startCloseTimer(2000);
          this.isSyncing = false;
          return;
        }

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

      // Execute uploads
      for (const op of operations.upload) {
        progressWindow.changeLine({
          text: `上传: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 15 + (completed / totalToSync) * 70,
        });

        const success = await this.executeUpload(op);
        if (success) {
          completed++;
        } else {
          failed++;
        }
      }

      // Execute downloads
      for (const op of operations.download) {
        progressWindow.changeLine({
          text: `下载: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 15 + (completed / totalToSync) * 70,
        });

        const success = await this.executeDownload(op);
        if (success) {
          completed++;
        } else {
          failed++;
        }
      }

      // Execute local deletes
      for (const op of operations.deleteLocal) {
        progressWindow.changeLine({
          text: `删除本地: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 15 + (completed / totalToSync) * 70,
        });

        const success = await this.executeDeleteLocal(op);
        if (success) {
          completed++;
        } else {
          failed++;
        }
      }

      // Execute remote deletes
      for (const op of operations.deleteRemote) {
        progressWindow.changeLine({
          text: `删除远程: ${op.attachmentKey} (${completed + 1}/${totalToSync})`,
          type: "default",
          progress: 15 + (completed / totalToSync) * 70,
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
            this.metadataManager.updateFileMetadata(op.attachmentKey, {
              hash: op.localHash,
              lastSyncHash: op.localHash,
              lastSyncTime: Date.now(),
            });
          }
        }
      }

      // Update last full sync time
      if (!isIncremental) {
        this.metadataManager.updateLastFullSync();
      }

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
    return new Promise((resolve) => {
      const dialogData: { [key: string | number | symbol]: any } = {
        conflictCount,
        resolution: null,
      };

      const dialogWindow = new ztoolkit.Dialog(3, 1)
        .setDialogData(dialogData)
        .addCell(0, 0, {
          tag: "h2",
          properties: {
            innerHTML: "同步冲突",
          },
        })
        .addCell(1, 0, {
          tag: "div",
          properties: {
            innerHTML: `发现 ${conflictCount} 个文件在云端和本地都有修改。<br><br>请选择如何处理：`,
          },
        })
        .addCell(2, 0, {
          tag: "div",
          styles: {
            display: "flex",
            gap: "10px",
            justifyContent: "center",
            marginTop: "20px",
          },
          children: [
            {
              tag: "button",
              properties: {
                innerHTML: "使用本地覆盖云端",
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = "upload";
                    dialogWindow.window?.close();
                  },
                },
              ],
            },
            {
              tag: "button",
              properties: {
                innerHTML: "使用云端覆盖本地",
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = "download";
                    dialogWindow.window?.close();
                  },
                },
              ],
            },
            {
              tag: "button",
              properties: {
                innerHTML: "取消同步",
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = "cancel";
                    dialogWindow.window?.close();
                  },
                },
              ],
            },
          ],
        })
        .open("同步冲突", {
          width: 500,
          height: 250,
          centerscreen: true,
          resizable: false,
        });

      // Wait for dialog to close
      dialogWindow.window?.addEventListener("unload", () => {
        resolve(dialogData.resolution || "cancel");
      });
    });
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
