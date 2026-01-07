pref("enable", true);
pref("input", "This is input");

// S3 Configuration
pref("s3.endpoint", "");
pref("s3.region", "us-east-1");
pref("s3.accessKeyId", "");
pref("s3.secretAccessKey", "");
pref("s3.bucketName", "");
pref("s3.prefix", "zotero-attachments");

// Sync Settings
pref("sync.autoSync", false);
pref("sync.syncInterval", 3600000); // 1 hour in milliseconds
pref("conflictResolution", "ask");
pref("sync.incremental", true);
pref("sync.incrementalMaxDays", 7);
pref("sync.concurrency", 3); // Number of concurrent upload/download operations
