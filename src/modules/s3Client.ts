import { getPref } from "../utils/prefs";

export interface S3FileMetadata {
  key: string;
  lastModified: number;
  size: number;
  etag: string; // S3's ETag (MD5 hash for simple uploads)
  metaMd5?: string; // Custom checksum stored as x-amz-meta-md5
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

  private encodeKey(key: string): string {
    // Encode each segment so special chars are signed correctly while keeping '/'
    return key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  private getUrl(key: string): string {
    const endpoint = this.endpoint.replace(/\/$/, "");
    // Force path-style URLs for all S3 services (including AWS)
    // Format: https://endpoint/bucket-name/key
    const encodedKey = this.encodeKey(key);
    return `${endpoint}/${this.bucketName}/${encodedKey}`;
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
    contentMd5?: string,
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
      if (contentMd5) {
        headers["x-amz-meta-md5"] = contentMd5;
      }

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
    fetchMetadata: boolean = false,
  ): Promise<S3FileMetadata[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const endpoint = this.endpoint.replace(/\/$/, "");
      const files: S3FileMetadata[] = [];
      let continuationToken: string | null = null;
      let page = 1;

      while (true) {
        const params = new URLSearchParams();
        params.set("list-type", "2");
        params.set("prefix", prefix);
        if (continuationToken) {
          params.set("continuation-token", continuationToken);
        }

        const url = `${endpoint}/${this.bucketName}?${params.toString()}`;
        const headers: Record<string, string> = {};
        const signedHeaders = await this.signRequest("GET", url, headers);

        // eslint-disable-next-line no-await-in-loop
        const pageData = await new Promise<{
          items: S3FileMetadata[];
          nextToken: string | null;
          isTruncated: boolean;
        }>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);

          Object.keys(signedHeaders).forEach((key) => {
            xhr.setRequestHeader(key, signedHeaders[key]);
          });

          xhr.onload = () => {
            ztoolkit.log(
              `S3 listFiles page ${page} response: status=${xhr.status}, length=${xhr.responseText?.length || 0}`,
            );

            if (xhr.status >= 200 && xhr.status < 300) {
              const parser = new DOMParser();
              const xmlDoc = parser.parseFromString(
                xhr.responseText || "",
                "text/xml",
              );
              const contents = xmlDoc.getElementsByTagName("Contents");
              const result: S3FileMetadata[] = [];

              // Log first 500 chars to help diagnose XML issues without flooding logs
              if (xhr.responseText && xhr.responseText.length > 0) {
                ztoolkit.log(
                  `XML snippet: ${xhr.responseText.substring(0, 500)}`,
                );
              }

              for (let i = 0; i < contents.length; i++) {
                const content = contents[i];
                const key =
                  content.getElementsByTagName("Key")[0]?.textContent || "";
                const lastModified =
                  content.getElementsByTagName("LastModified")[0]
                    ?.textContent || "";
                const size =
                  content.getElementsByTagName("Size")[0]?.textContent || "0";
                const etag =
                  content.getElementsByTagName("ETag")[0]?.textContent || "";

                result.push({
                  key,
                  lastModified: lastModified
                    ? new Date(lastModified).getTime()
                    : 0,
                  size: parseInt(size, 10),
                  etag: etag.replace(/"/g, ""), // Remove quotes from ETag
                });
              }

              const nextToken =
                xmlDoc.getElementsByTagName("NextContinuationToken")[0]
                  ?.textContent || null;
              const isTruncated =
                xmlDoc.getElementsByTagName("IsTruncated")[0]?.textContent ===
                "true";

              resolve({
                items: result,
                nextToken,
                isTruncated,
              });
            } else {
              ztoolkit.log(
                `S3 listFiles failed: ${xhr.status} ${xhr.statusText}`,
              );
              ztoolkit.log(`Response body: ${xhr.responseText}`);
              resolve({
                items: [],
                nextToken: null,
                isTruncated: false,
              });
            }
          };

          xhr.onerror = () => {
            ztoolkit.log("S3 listFiles network error");
            resolve({
              items: [],
              nextToken: null,
              isTruncated: false,
            });
          };

          xhr.send();
        });

        files.push(...pageData.items);

        continuationToken = pageData.nextToken;
        if (!pageData.isTruncated || !continuationToken) {
          break;
        }
        page += 1;
      }

      if (fetchMetadata && files.length > 0) {
        // Fetch object metadata (x-amz-meta-md5) for better checksum comparison
        for (const fileMeta of files) {
          // eslint-disable-next-line no-await-in-loop
          const meta = await this.getObjectMetadata(fileMeta.key);
          if (meta?.metaMd5) {
            fileMeta.metaMd5 = meta.metaMd5;
          }
        }
      }

      return files;
    } catch (error) {
      ztoolkit.log("Failed to list files:", error);
      return [];
    }
  }

  /**
   * Get object metadata (e.g., x-amz-meta-md5) via HEAD
   */
  public async getObjectMetadata(
    key: string,
  ): Promise<S3FileMetadata | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const url = this.getUrl(key);
      const headers: Record<string, string> = {};
      const signedHeaders = await this.signRequest("HEAD", url, headers);

      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", url, true);

      Object.keys(signedHeaders).forEach((k) => {
        xhr.setRequestHeader(k, signedHeaders[k]);
      });

      return await new Promise<S3FileMetadata | null>((resolve) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const lastModified = xhr.getResponseHeader("Last-Modified");
            const sizeHeader = xhr.getResponseHeader("Content-Length");
            const etagHeader = xhr.getResponseHeader("ETag");
            const metaMd5 = xhr.getResponseHeader("x-amz-meta-md5") || undefined;

            resolve({
              key,
              lastModified: lastModified
                ? new Date(lastModified).getTime()
                : 0,
              size: sizeHeader ? parseInt(sizeHeader, 10) : 0,
              etag: etagHeader ? etagHeader.replace(/"/g, "") : "",
              metaMd5,
            });
          } else {
            resolve(null);
          }
        };

        xhr.onerror = () => resolve(null);
        xhr.send();
      });
    } catch (error) {
      return null;
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
