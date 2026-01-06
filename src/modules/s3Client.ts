import { getPref } from "../utils/prefs";

export interface S3FileMetadata {
  key: string;
  lastModified: number;
  size: number;
  etag: string; // S3's ETag (MD5 hash for simple uploads)
}

export class S3Manager {
  private endpoint: string = "";
  private region: string = "";
  private accessKeyId: string = "";
  private secretAccessKey: string = "";
  private bucketName: string = "";

  constructor() {
    this.initializeClient();
  }

  private initializeClient(): void {
    try {
      // Trim all configuration values to remove leading/trailing whitespace
      this.endpoint = ((getPref("s3.endpoint") as string) || "").trim();
      this.region = ((getPref("s3.region") as string) || "").trim();
      this.accessKeyId = ((getPref("s3.accessKeyId") as string) || "").trim();
      this.secretAccessKey = ((getPref("s3.secretAccessKey") as string) || "").trim();
      this.bucketName = ((getPref("s3.bucketName") as string) || "").trim();

      if (
        !this.endpoint ||
        !this.region ||
        !this.accessKeyId ||
        !this.secretAccessKey ||
        !this.bucketName
      ) {
        ztoolkit.log("S3 configuration incomplete");
        return;
      }

      ztoolkit.log("S3 client initialized successfully");
    } catch (error) {
      ztoolkit.log("Failed to initialize S3 client:", error);
    }
  }

  public isConfigured(): boolean {
    return !!(
      this.endpoint &&
      this.region &&
      this.accessKeyId &&
      this.secretAccessKey &&
      this.bucketName
    );
  }

  public reloadConfig(): void {
    this.initializeClient();
  }

  private getUrl(key: string): string {
    const endpoint = this.endpoint.replace(/\/$/, "");
    // Force path-style URLs for all S3 services (including AWS)
    // Format: https://endpoint/bucket-name/key
    return `${endpoint}/${this.bucketName}/${key}`;
  }

  private async sha256Hex(data: string | Uint8Array): Promise<string> {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    // Use Web Crypto API instead of XPCOM
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = new Uint8Array(hashBuffer);

    return Array.from(hashArray, (byte) =>
      ("0" + byte.toString(16)).slice(-2),
    ).join("");
  }

  private async signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Record<string, string>> {
    const urlObj = new URL(url);
    const host = urlObj.host;
    const path = urlObj.pathname || "/";
    const queryString = urlObj.search.slice(1); // Remove leading '?'

    const dateTime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = dateTime.substr(0, 8);

    headers["Host"] = host;
    headers["x-amz-date"] = dateTime;

    // Calculate content hash
    const contentHash = body
      ? await this.sha256Hex(body)
      : await this.sha256Hex(new Uint8Array(0));
    headers["x-amz-content-sha256"] = contentHash;

    // Create canonical request
    const canonicalHeaders = Object.keys(headers)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((k) => `${k.toLowerCase()}:${headers[k].trim()}`)
      .join("\n");

    const signedHeaders = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort()
      .join(";");

    const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n\n${signedHeaders}\n${contentHash}`;

    // Debug logging
    ztoolkit.log(`Canonical request details:`);
    ztoolkit.log(`  Method: ${method}`);
    ztoolkit.log(`  Path: ${path}`);
    ztoolkit.log(`  Query: ${queryString}`);
    ztoolkit.log(`  Headers: ${canonicalHeaders}`);

    // Create string to sign
    const canonicalRequestHash = await this.sha256Hex(canonicalRequest);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${canonicalRequestHash}`;

    // Calculate signature
    const signature = await this.calculateSignature(date, stringToSign);

    // Add authorization header
    headers["Authorization"] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }

  private async calculateSignature(
    date: string,
    stringToSign: string,
  ): Promise<string> {
    let key: Uint8Array = await this.hmacSha256(
      `AWS4${this.secretAccessKey}`,
      date,
    );
    key = await this.hmacSha256Bytes(key, this.region);
    key = await this.hmacSha256Bytes(key, "s3");
    key = await this.hmacSha256Bytes(key, "aws4_request");
    const signatureBytes = await this.hmacSha256Bytes(key, stringToSign);

    return Array.from(signatureBytes, (byte) =>
      ("0" + byte.toString(16)).slice(-2),
    ).join("");
  }

  private async hmacSha256(key: string, data: string): Promise<Uint8Array> {
    const keyBytes = new TextEncoder().encode(key);
    return await this.hmacSha256Bytes(keyBytes, data);
  }

  private async hmacSha256Bytes(
    key: Uint8Array,
    data: string,
  ): Promise<Uint8Array> {
    const dataBytes = new TextEncoder().encode(data);

    // Use Web Crypto API instead of XPCOM
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
    return new Uint8Array(signature);
  }

  public async uploadFile(
    file: Blob,
    key: string,
    onProgress?: (progress: number) => void,
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      ztoolkit.log("S3 client not configured");
      return false;
    }

    try {
      const url = this.getUrl(key);
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      const headers: Record<string, string> = {
        "Content-Type": file.type || "application/octet-stream",
      };

      const signedHeaders = await this.signRequest(
        "PUT",
        url,
        headers,
        uint8Array,
      );

      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);

      // Set headers
      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      // Progress tracking
      if (onProgress) {
        xhr.upload.addEventListener("progress", (e: any) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            onProgress(percent);
          }
        });
      }

      return new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            ztoolkit.log(`File uploaded successfully: ${key}`);
            resolve(true);
          } else {
            ztoolkit.log(
              `Failed to upload file ${key}: ${xhr.status} ${xhr.statusText}`,
            );
            resolve(false);
          }
        };

        xhr.onerror = () => {
          ztoolkit.log(`Network error uploading file ${key}`);
          resolve(false);
        };

        xhr.send(uint8Array);
      });
    } catch (error) {
      ztoolkit.log(`Failed to upload file ${key}:`, error);
      return false;
    }
  }

  public async downloadFile(key: string): Promise<Blob | null> {
    if (!this.isConfigured()) {
      ztoolkit.log("S3 client not configured");
      return null;
    }

    try {
      const url = this.getUrl(key);
      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("GET", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "blob";

      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      return new Promise((resolve) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            ztoolkit.log(`File downloaded successfully: ${key}`);
            resolve(xhr.response);
          } else {
            ztoolkit.log(`Failed to download file ${key}: ${xhr.status}`);
            resolve(null);
          }
        };

        xhr.onerror = () => {
          ztoolkit.log(`Network error downloading file ${key}`);
          resolve(null);
        };

        xhr.send();
      });
    } catch (error) {
      ztoolkit.log(`Failed to download file ${key}:`, error);
      return null;
    }
  }

  public async fileExists(key: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const url = this.getUrl(key);
      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("HEAD", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", url, true);

      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      return new Promise((resolve) => {
        xhr.onload = () => {
          resolve(xhr.status >= 200 && xhr.status < 300);
        };

        xhr.onerror = () => {
          resolve(false);
        };

        xhr.send();
      });
    } catch (error) {
      return false;
    }
  }

  public async getFileModTime(key: string): Promise<number> {
    if (!this.isConfigured()) {
      return 0;
    }

    try {
      const url = this.getUrl(key);
      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("HEAD", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", url, true);

      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      return new Promise((resolve) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            // Get Last-Modified header
            const lastModified = xhr.getResponseHeader("Last-Modified");
            if (lastModified) {
              const modTime = new Date(lastModified).getTime();
              resolve(modTime);
            } else {
              resolve(0);
            }
          } else {
            resolve(0);
          }
        };

        xhr.onerror = () => {
          resolve(0);
        };

        xhr.send();
      });
    } catch (error) {
      return 0;
    }
  }

  public async listFiles(prefix: string = ""): Promise<string[]> {
    const files = await this.listFilesWithMetadata(prefix);
    return files.map((f) => f.key);
  }

  public async listFilesWithMetadata(
    prefix: string = "",
  ): Promise<S3FileMetadata[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const endpoint = this.endpoint.replace(/\/$/, "");
      const url = `${endpoint}/${this.bucketName}?prefix=${encodeURIComponent(prefix)}`;

      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("GET", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);

      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      return new Promise((resolve) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            // Parse XML response
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(
              xhr.responseText || "",
              "text/xml",
            );
            const files: S3FileMetadata[] = [];
            const contents = xmlDoc.getElementsByTagName("Contents");

            for (let i = 0; i < contents.length; i++) {
              const content = contents[i];
              const key =
                content.getElementsByTagName("Key")[0]?.textContent || "";
              const lastModified =
                content.getElementsByTagName("LastModified")[0]?.textContent ||
                "";
              const size =
                content.getElementsByTagName("Size")[0]?.textContent || "0";
              const etag =
                content.getElementsByTagName("ETag")[0]?.textContent || "";

              files.push({
                key,
                lastModified: lastModified
                  ? new Date(lastModified).getTime()
                  : 0,
                size: parseInt(size, 10),
                etag: etag.replace(/"/g, ""), // Remove quotes from ETag
              });
            }
            resolve(files);
          } else {
            resolve([]);
          }
        };

        xhr.onerror = () => {
          resolve([]);
        };

        xhr.send();
      });
    } catch (error) {
      ztoolkit.log("Failed to list files:", error);
      return [];
    }
  }

  public async testConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      ztoolkit.log("S3 not configured");
      return false;
    }

    try {
      ztoolkit.log("Testing S3 connection...");

      // Force path-style URL for all S3 services
      const endpoint = this.endpoint.replace(/\/$/, "");
      const url = `${endpoint}/${this.bucketName}?max-keys=1`;

      ztoolkit.log(`Testing connection to: ${url}`);

      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("GET", url, headers);

      ztoolkit.log(`Request headers:`, signedHeaders);

      return new Promise<boolean>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.timeout = 10000; // 10 second timeout

        Object.keys(signedHeaders).forEach((key) => {
          xhr.setRequestHeader(key, signedHeaders[key]);
        });

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            ztoolkit.log("S3 connection test successful");
            resolve(true);
          } else {
            ztoolkit.log(
              `S3 connection test failed with status ${xhr.status}: ${xhr.statusText}`,
            );
            ztoolkit.log(`Response body: ${xhr.responseText}`);
            ztoolkit.log(`Request URL: ${url}`);
            resolve(false);
          }
        };

        xhr.onerror = (e) => {
          ztoolkit.log("S3 connection test failed: network error");
          ztoolkit.log(`Error details:`, e);
          ztoolkit.log(`Request URL: ${url}`);
          resolve(false);
        };

        xhr.ontimeout = () => {
          ztoolkit.log("S3 connection test failed: timeout");
          ztoolkit.log(`Request URL: ${url}`);
          resolve(false);
        };

        xhr.send();
      });
    } catch (error) {
      ztoolkit.log("S3 connection test failed with exception");
      ztoolkit.log(
        "Error message:",
        error instanceof Error ? error.message : String(error),
      );
      ztoolkit.log(
        "Error stack:",
        error instanceof Error ? error.stack : "N/A",
      );
      ztoolkit.log("Error object:", error);
      return false;
    }
  }

  public async deleteFile(key: string): Promise<boolean> {
    if (!this.isConfigured()) {
      ztoolkit.log("S3 client not configured");
      return false;
    }

    try {
      const url = this.getUrl(key);
      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("DELETE", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("DELETE", url, true);

      Object.keys(signedHeaders).forEach((key) => {
        xhr.setRequestHeader(key, signedHeaders[key]);
      });

      return new Promise((resolve) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            ztoolkit.log(`File deleted successfully: ${key}`);
            resolve(true);
          } else {
            ztoolkit.log(`Failed to delete file ${key}: ${xhr.status}`);
            resolve(false);
          }
        };

        xhr.onerror = () => {
          ztoolkit.log(`Network error deleting file ${key}`);
          resolve(false);
        };

        xhr.send();
      });
    } catch (error) {
      ztoolkit.log(`Failed to delete file ${key}:`, error);
      return false;
    }
  }

  public reinitialize(): void {
    this.initializeClient();
  }
}
