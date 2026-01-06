import { S3Manager } from "./s3Client";
import { getPref, setPref } from "../utils/prefs";

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
  resolution?: 'upload' | 'download' | 'skip';
}

export class SyncManager {
  private s3Manager: S3Manager;
  private syncQueue: SyncItem[] = [];
  private isSyncing: boolean = false;

  constructor() {
    this.s3Manager = new S3Manager();
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

    const progressWindow = new ztoolkit.ProgressWindow("S3 云同步")
      .createLine({
        text: "正在扫描附件...",
        type: "default",
        progress: 0,
      })
      .show();

    try {
      const items = await this.getAttachmentsToSync();
      ztoolkit.log(`Found ${items.length} attachments to sync`);

      if (items.length === 0) {
        progressWindow.changeLine({
          text: "所有文件已同步",
          type: "success",
          progress: 100,
        });
        progressWindow.startCloseTimer(5000);
        this.isSyncing = false;
        return;
      }

      // Check for conflicts before syncing
      progressWindow.changeLine({
        text: `检查 ${items.length} 个附件的冲突...`,
        type: "default",
        progress: 5,
      });

      const conflicts = await this.detectConflicts(items);

      if (conflicts.length > 0) {
        const resolution = await this.showConflictDialog(conflicts.length);

        if (resolution === 'cancel') {
          progressWindow.changeLine({
            text: "用户取消同步",
            type: "default",
            progress: 0,
          });
          progressWindow.startCloseTimer(2000);
          this.isSyncing = false;
          return;
        }

        // Apply resolution to all items
        for (const conflict of conflicts) {
          conflict.resolution = resolution;
        }
      }

      let synced = 0;
      let skipped = 0;
      const concurrencyLimit = 5; // Maximum concurrent operations
      let activeCount = 0;
      let completedCount = 0;

      // Process items with concurrency limit
      await new Promise<void>((resolve) => {
        let currentIndex = 0;

        const processNext = async () => {
          if (currentIndex >= items.length) {
            if (activeCount === 0) {
              resolve();
            }
            return;
          }

          const index = currentIndex++;
          const item = items[index];
          const conflict = conflicts.find(c => c.item.attachmentKey === item.attachmentKey);

          activeCount++;

          try {
            const currentProgress = 10 + ((completedCount / items.length) * 85);

            progressWindow.changeLine({
              text: `同步中: ${item.attachmentKey} (${completedCount + 1}/${items.length})`,
              type: "default",
              progress: currentProgress,
            });

            const success = await this.syncAttachment(item, conflict?.resolution);

            if (success) {
              synced++;
              await this.updateSyncRecord(item);
            } else {
              skipped++;
            }
          } catch (error) {
            ztoolkit.log(`Failed to sync attachment ${item.attachmentKey}:`, error);
            skipped++;
          } finally {
            activeCount--;
            completedCount++;

            // Update progress
            const currentProgress = 10 + ((completedCount / items.length) * 85);
            progressWindow.changeLine({
              text: `已完成 ${completedCount}/${items.length} (成功: ${synced}, 跳过: ${skipped})`,
              type: "default",
              progress: currentProgress,
            });

            // Process next item or resolve if done
            if (currentIndex < items.length) {
              processNext();
            } else if (activeCount === 0) {
              resolve();
            }
          }
        };

        // Start initial batch of operations
        for (let i = 0; i < Math.min(concurrencyLimit, items.length); i++) {
          processNext();
        }
      });

      // Clear sync status
      addon.data.syncStatus = { isSyncing: false };
      this.updateToolbarTooltip("S3 云同步");

      progressWindow.changeLine({
        text: `Sync complete: ${synced} synced, ${skipped} skipped`,
        type: "success",
        progress: 100,
      });
      progressWindow.startCloseTimer(3000);
    } catch (error) {
      ztoolkit.log("Sync error:", error);
      progressWindow.changeLine({
        text: `Sync failed: ${error}`,
        type: "error",
        progress: 0,
      });
      progressWindow.startCloseTimer(5000);
    } finally {
      this.isSyncing = false;
    }
  }

  private async getAttachmentsToSync(): Promise<SyncItem[]> {
    const items: SyncItem[] = [];

    try {
      // Get all libraries
      const libraries = Zotero.Libraries.getAll();

      ztoolkit.log(`Found ${libraries.length} libraries to scan`);

      for (const library of libraries) {
        // Skip if library doesn't support files
        if (!library.filesEditable) {
          ztoolkit.log(`Skipping library ${library.name} - files not editable`);
          continue;
        }

        ztoolkit.log(`Scanning library: ${library.name}`);

        // Get all items in the library
        const libraryID = library.libraryID;
        const itemIDs = await Zotero.Items.getAll(libraryID, false, false, true);

        ztoolkit.log(`Found ${itemIDs.length} items in library ${library.name}`);

        let attachmentCount = 0;
        let fileAttachmentCount = 0;
        let attachmentWithPathCount = 0;

        for (const itemID of itemIDs) {
          const item = await Zotero.Items.getAsync(itemID);

          if (item && item.isAttachment()) {
            attachmentCount++;

            if (item.isFileAttachment()) {
              fileAttachmentCount++;
              const file = await item.getFilePathAsync();

              if (file) {
                attachmentWithPathCount++;
                const hash = await this.getFileHash(file);
                const lastSync = this.getLastSyncTime(item.key);
                const storedHash = this.getStoredHash(item.key);

                // Include file if:
                // 1. Never synced before (lastSync === 0)
                // 2. Hash has changed (storedHash !== hash)
                // 3. No stored hash (first time tracking)
                const needsSync = lastSync === 0 || !storedHash || storedHash !== hash;

                if (needsSync) {
                  ztoolkit.log(`Adding attachment to sync: ${item.key} (lastSync: ${lastSync}, storedHash: ${storedHash}, currentHash: ${hash})`);
                  items.push({
                    itemID: item.id,
                    attachmentKey: item.key,
                    filePath: file,
                    hash: hash,
                    lastSync: lastSync,
                  });
                } else {
                  // Only log first few to avoid spam
                  if (items.length < 3) {
                    ztoolkit.log(`Skipping attachment ${item.key} - already synced`);
                  }
                }
              }
            }
          }
        }

        ztoolkit.log(`Library ${library.name}: ${attachmentCount} attachments, ${fileAttachmentCount} file attachments, ${attachmentWithPathCount} with paths`);
      }
    } catch (error) {
      ztoolkit.log("Error getting attachments:", error);
      ztoolkit.log("Error message:", error instanceof Error ? error.message : String(error));
      ztoolkit.log("Error stack:", error instanceof Error ? error.stack : "N/A");
    }

    return items;
  }

  private async syncAttachment(item: SyncItem, resolution?: 'upload' | 'download' | 'skip'): Promise<boolean> {
    const s3Key = this.getS3Key(item.attachmentKey);

    try {
      // If resolution is skip, don't do anything
      if (resolution === 'skip') {
        return false;
      }

      // Check if file exists on S3
      const existsOnS3 = await this.s3Manager.fileExists(s3Key);

      if (!existsOnS3) {
        // Upload to S3
        const file = await this.readFileAsBlob(item.filePath);
        if (file) {
          return await this.s3Manager.uploadFile(file, s3Key);
        }
      } else {
        // File exists on S3
        if (resolution === 'upload') {
          // Force upload local to S3
          const file = await this.readFileAsBlob(item.filePath);
          if (file) {
            return await this.s3Manager.uploadFile(file, s3Key);
          }
        } else if (resolution === 'download') {
          // Force download from S3 to local
          const blob = await this.s3Manager.downloadFile(s3Key);
          if (blob) {
            await this.writeBlobToFile(blob, item.filePath);
            return true;
          }
          return false;
        } else {
          // No conflict resolution, check if local is newer
          const localModTime = await this.getFileModTime(item.filePath);
          if (localModTime > item.lastSync) {
            const file = await this.readFileAsBlob(item.filePath);
            if (file) {
              return await this.s3Manager.uploadFile(file, s3Key);
            }
          }
        }
      }

      return true;
    } catch (error) {
      ztoolkit.log(`Error syncing attachment ${item.attachmentKey}:`, error);
      return false;
    }
  }

  private async needsSync(attachmentKey: string, currentHash: string): Promise<boolean> {
    // @ts-expect-error - Dynamic pref keys
    const storedHash = getPref(`sync.hash.${attachmentKey}`) as string;
    return storedHash !== currentHash;
  }

  private async updateSyncRecord(item: SyncItem): Promise<void> {
    // @ts-expect-error - Dynamic pref keys
    setPref(`sync.hash.${item.attachmentKey}`, item.hash);
    // @ts-expect-error - Dynamic pref keys
    setPref(`sync.time.${item.attachmentKey}`, Date.now());
  }

  private getLastSyncTime(attachmentKey: string): number {
    // @ts-expect-error - Dynamic pref keys
    return (getPref(`sync.time.${attachmentKey}`) as number) || 0;
  }

  private getStoredHash(attachmentKey: string): string {
    // @ts-expect-error - Dynamic pref keys
    return (getPref(`sync.hash.${attachmentKey}`) as string) || '';
  }

  private getS3Key(attachmentKey: string): string {
    const prefix = getPref("s3.prefix") as string || "zotero-attachments";
    return `${prefix}/${attachmentKey}`;
  }

  private async getFileHash(filePath: string): Promise<string> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      // @ts-expect-error - Zotero XPCOM types
      const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Components.interfaces.nsIFileInputStream);
      stream.init(file, -1, 0, 0);

      // @ts-expect-error - Zotero XPCOM types
      const hash = Components.classes["@mozilla.org/security/hash;1"]
        .createInstance(Components.interfaces.nsICryptoHash);
      hash.init(hash.MD5);
      hash.updateFromStream(stream, stream.available());

      const hashBytes = hash.finish(false);
      const hashString = Array.from(hashBytes, (byte: number) =>
        ("0" + (byte & 0xff).toString(16)).slice(-2)
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

  private async readFileAsBlob(filePath: string): Promise<Blob | null> {
    try {
      const file = Zotero.File.pathToFile(filePath);
      // @ts-expect-error - Zotero XPCOM types
      const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Components.interfaces.nsIFileInputStream);
      stream.init(file, -1, 0, 0);

      // @ts-expect-error - Zotero XPCOM types
      const binaryStream = Components.classes["@mozilla.org/binaryinputstream;1"]
        .createInstance(Components.interfaces.nsIBinaryInputStream);
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
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, attachmentKey);
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
    const stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Components.interfaces.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);

    // @ts-expect-error - Zotero XPCOM types
    const binaryStream = Components.classes["@mozilla.org/binaryoutputstream;1"]
      .createInstance(Components.interfaces.nsIBinaryOutputStream);
    binaryStream.setOutputStream(stream);

    binaryStream.writeByteArray(Array.from(uint8Array), uint8Array.length);
    binaryStream.close();
    stream.close();
  }

  private async detectConflicts(items: SyncItem[]): Promise<SyncConflict[]> {
    const conflicts: SyncConflict[] = [];

    for (const item of items) {
      try {
        const s3Key = this.getS3Key(item.attachmentKey);
        const existsOnS3 = await this.s3Manager.fileExists(s3Key);

        if (existsOnS3) {
          // Get modification times
          const localModTime = await this.getFileModTime(item.filePath);
          const s3ModTime = await this.s3Manager.getFileModTime(s3Key);

          // Check if both were modified since last sync
          if (item.lastSync > 0 && localModTime > item.lastSync && s3ModTime > item.lastSync) {
            conflicts.push({
              item,
              localModTime,
              s3ModTime,
            });
          }
        }
      } catch (error) {
        ztoolkit.log(`Error detecting conflict for ${item.attachmentKey}:`, error);
      }
    }

    return conflicts;
  }

  private async showConflictDialog(conflictCount: number): Promise<'upload' | 'download' | 'cancel'> {
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
            innerHTML: "同步冲突"
          }
        })
        .addCell(1, 0, {
          tag: "div",
          properties: {
            innerHTML: `发现 ${conflictCount} 个文件在云端和本地都有修改。<br><br>请选择如何处理：`
          }
        })
        .addCell(2, 0, {
          tag: "div",
          styles: {
            display: "flex",
            gap: "10px",
            justifyContent: "center",
            marginTop: "20px"
          },
          children: [
            {
              tag: "button",
              properties: {
                innerHTML: "使用本地覆盖云端"
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = 'upload';
                    dialogWindow.window?.close();
                  }
                }
              ]
            },
            {
              tag: "button",
              properties: {
                innerHTML: "使用云端覆盖本地"
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = 'download';
                    dialogWindow.window?.close();
                  }
                }
              ]
            },
            {
              tag: "button",
              properties: {
                innerHTML: "取消同步"
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    dialogData.resolution = 'cancel';
                    dialogWindow.window?.close();
                  }
                }
              ]
            }
          ]
        })
        .open("同步冲突", {
          width: 500,
          height: 250,
          centerscreen: true,
          resizable: false,
        });

      // Wait for dialog to close
      dialogWindow.window?.addEventListener('unload', () => {
        resolve(dialogData.resolution || 'cancel');
      });
    });
  }

  private updateToolbarTooltip(text: string): void {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return;

      const button = win.document.querySelector("#zotero-tb-s3sync") as XUL.Element;
      if (button) {
        button.setAttribute("tooltiptext", text);
      }
    } catch (error) {
      // Ignore errors if button doesn't exist
    }
  }
}
