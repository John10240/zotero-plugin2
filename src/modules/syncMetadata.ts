/**
 * Sync Metadata Manager
 * Manages synchronization metadata for bidirectional sync between local and S3
 */

export interface FileMetadata {
  hash: string; // MD5 hash of file content
  localMtime: number; // Local modification time (ms)
  remoteMtime: number; // Remote modification time (ms)
  lastSyncTime: number; // Last sync timestamp (ms)
  lastSyncHash: string; // Hash at last sync
  size: number; // File size in bytes
}

export interface SyncMetadataStore {
  files: {
    [attachmentKey: string]: FileMetadata;
  };
  lastFullSync: number; // Last full sync timestamp
  version: number; // Metadata format version
}

export class SyncMetadataManager {
  private static readonly METADATA_KEY = "sync.metadata";
  private static readonly METADATA_VERSION = 1;
  private metadata: SyncMetadataStore;

  constructor() {
    this.metadata = this.loadMetadata();
  }

  /**
   * Load metadata from Zotero preferences
   */
  private loadMetadata(): SyncMetadataStore {
    try {
      const stored = Zotero.Prefs.get(
        `extensions.zotero.s3sync.${SyncMetadataManager.METADATA_KEY}`,
        true,
      ) as string;

      if (stored) {
        const parsed = JSON.parse(stored) as SyncMetadataStore;

        // Validate version
        if (parsed.version === SyncMetadataManager.METADATA_VERSION) {
          return parsed;
        }

        ztoolkit.log("Metadata version mismatch, creating new metadata");
      }
    } catch (error) {
      ztoolkit.log("Error loading metadata:", error);
    }

    // Return empty metadata if not found or error
    return {
      files: {},
      lastFullSync: 0,
      version: SyncMetadataManager.METADATA_VERSION,
    };
  }

  /**
   * Save metadata to Zotero preferences
   */
  private saveMetadata(): void {
    try {
      const serialized = JSON.stringify(this.metadata);
      Zotero.Prefs.set(
        `extensions.zotero.s3sync.${SyncMetadataManager.METADATA_KEY}`,
        serialized,
        true,
      );
    } catch (error) {
      ztoolkit.log("Error saving metadata:", error);
    }
  }

  /**
   * Get metadata for a specific file
   */
  public getFileMetadata(attachmentKey: string): FileMetadata | null {
    return this.metadata.files[attachmentKey] || null;
  }

  /**
   * Update metadata for a file
   */
  public updateFileMetadata(
    attachmentKey: string,
    metadata: Partial<FileMetadata>,
  ): void {
    const existing = this.metadata.files[attachmentKey] || {
      hash: "",
      localMtime: 0,
      remoteMtime: 0,
      lastSyncTime: 0,
      lastSyncHash: "",
      size: 0,
    };

    this.metadata.files[attachmentKey] = {
      ...existing,
      ...metadata,
    };

    this.saveMetadata();
  }

  /**
   * Record successful sync for a file
   */
  public recordSync(
    attachmentKey: string,
    hash: string,
    localMtime: number,
    remoteMtime: number,
    size: number,
  ): void {
    const now = Date.now();

    this.metadata.files[attachmentKey] = {
      hash,
      localMtime,
      remoteMtime,
      lastSyncTime: now,
      lastSyncHash: hash,
      size,
    };

    this.saveMetadata();
  }

  /**
   * Remove metadata for a file
   */
  public removeFileMetadata(attachmentKey: string): void {
    delete this.metadata.files[attachmentKey];
    this.saveMetadata();
  }

  /**
   * Update last full sync time
   */
  public updateLastFullSync(): void {
    this.metadata.lastFullSync = Date.now();
    this.saveMetadata();
  }

  /**
   * Get last full sync time
   */
  public getLastFullSync(): number {
    return this.metadata.lastFullSync;
  }

  /**
   * Get all file metadata
   */
  public getAllFileMetadata(): { [key: string]: FileMetadata } {
    return { ...this.metadata.files };
  }

  /**
   * Clear all metadata (use with caution!)
   */
  public clearAll(): void {
    this.metadata = {
      files: {},
      lastFullSync: 0,
      version: SyncMetadataManager.METADATA_VERSION,
    };
    this.saveMetadata();
  }

  /**
   * Export metadata for debugging
   */
  public exportMetadata(): string {
    return JSON.stringify(this.metadata, null, 2);
  }

  /**
   * Get metadata statistics
   */
  public getStats(): {
    totalFiles: number;
    lastFullSync: number;
    oldestSync: number;
    newestSync: number;
  } {
    const files = Object.values(this.metadata.files);
    const syncTimes = files.map((f) => f.lastSyncTime).filter((t) => t > 0);

    return {
      totalFiles: files.length,
      lastFullSync: this.metadata.lastFullSync,
      oldestSync: syncTimes.length > 0 ? Math.min(...syncTimes) : 0,
      newestSync: syncTimes.length > 0 ? Math.max(...syncTimes) : 0,
    };
  }
}
