import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Request } from "express";
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const UPLOAD_TTL_SECONDS = 15 * 60;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const OBJECT_PREFIX = "/objects/";

type StorageDriver = "s3" | "local";

type UploadOptions = {
  contentType: string;
  size: number;
  origin: string;
};

type StoredFile = {
  objectPath: string;
  key: string;
  contentType?: string;
  size?: number;
};

type LocalUploadToken = {
  objectPath: string;
  contentType: string;
  size: number;
  expiresAt: number;
};

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

/**
 * Storage is deliberately provider-neutral:
 * - local is the default everywhere and is suitable for a persistent application
 *   disk (for example Render/Railway volumes).
 * - production can opt into any S3-compatible provider (AWS S3, Cloudflare R2,
 *   MinIO, etc.) with STORAGE_DRIVER=s3.
 * No Replit storage service or project binding is required.
 */
export class ObjectStorageService {
  private readonly driver: StorageDriver;
  private s3Client: S3Client | null = null;

  constructor() {
    const configured = process.env.STORAGE_DRIVER?.trim().toLowerCase();
    this.driver = configured === "s3" ? "s3" : "local";
  }

  async getUploadUrl(options: UploadOptions): Promise<{ uploadURL: string; objectPath: string }> {
    if (!Number.isInteger(options.size) || options.size < 1 || options.size > MAX_FILE_SIZE) {
      throw new Error(`File size must be between 1 byte and ${MAX_FILE_SIZE} bytes`);
    }
    if (!options.contentType.trim()) {
      throw new Error("A content type is required");
    }

    const objectPath = `${OBJECT_PREFIX}uploads/${randomUUID()}`;
    if (this.driver === "local") {
      const token = this.createLocalUploadToken({
        objectPath,
        contentType: options.contentType,
        size: options.size,
        expiresAt: Date.now() + UPLOAD_TTL_SECONDS * 1000,
      });
      return {
        uploadURL: `${options.origin}/api/storage/uploads/${token}`,
        objectPath,
      };
    }

    const { client, bucket } = this.getS3Config();
    const key = this.keyFromObjectPath(objectPath);
    const uploadURL = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.size,
      }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );
    return { uploadURL, objectPath };
  }

  async receiveLocalUpload(token: string, req: Request): Promise<void> {
    if (this.driver !== "local") {
      throw new Error("Local uploads are disabled for this storage driver");
    }

    const upload = this.verifyLocalUploadToken(token);
    const declaredSize = Number(req.headers["content-length"]);
    const declaredType = String(req.headers["content-type"] ?? "");
    if (!Number.isInteger(declaredSize) || declaredSize !== upload.size) {
      throw new Error("Uploaded file size did not match the requested size");
    }
    if (declaredType !== upload.contentType) {
      throw new Error("Uploaded file content type did not match the requested type");
    }

    const destination = this.localFilePath(upload.objectPath);
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(req, createWriteStream(destination, { flags: "wx" }));
    const saved = await stat(destination);
    if (saved.size !== upload.size) {
      throw new Error("Uploaded file size did not match the requested size");
    }
  }

  async getFile(objectPath: string): Promise<StoredFile> {
    const key = this.keyFromObjectPath(objectPath);
    if (this.driver === "local") {
      const localPath = this.localFilePath(objectPath);
      try {
        const metadata = await stat(localPath);
        return { objectPath, key, size: metadata.size };
      } catch {
        throw new ObjectNotFoundError();
      }
    }

    const { client, bucket } = this.getS3Config();
    try {
      const metadata = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        objectPath,
        key,
        contentType: metadata.ContentType,
        size: metadata.ContentLength,
      };
    } catch {
      throw new ObjectNotFoundError();
    }
  }

  async download(file: StoredFile): Promise<Response> {
    if (this.driver === "local") {
      const stream = Readable.toWeb(createReadStream(this.localFilePath(file.objectPath))) as ReadableStream;
      return new Response(stream, {
        headers: this.downloadHeaders(file.contentType, file.size),
      });
    }

    const { client, bucket } = this.getS3Config();
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }));
      if (!response.Body) throw new ObjectNotFoundError();
      const body = response.Body as unknown as AsyncIterable<Uint8Array>;
      const stream = Readable.toWeb(Readable.from(body)) as ReadableStream;
      return new Response(stream, {
        headers: this.downloadHeaders(response.ContentType, response.ContentLength),
      });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw error;
      throw new ObjectNotFoundError();
    }
  }

  async deleteObject(objectPath: string): Promise<void> {
    const key = this.keyFromObjectPath(objectPath);
    if (this.driver === "local") {
      try {
        await unlink(this.localFilePath(objectPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }

    const { client, bucket } = this.getS3Config();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  private getPrivateObjectDir(): string {
    return process.env.STORAGE_LOCAL_DIR?.trim() || ".data/objects";
  }

  private localFilePath(objectPath: string): string {
    const relative = objectPath.replace(/^\/objects\//, "");
    const root = resolve(this.getPrivateObjectDir());
    const destination = resolve(join(root, relative));
    if (destination !== root && !destination.startsWith(`${root}/`)) {
      throw new Error("Invalid object path");
    }
    return destination;
  }

  private keyFromObjectPath(objectPath: string): string {
    if (!objectPath.startsWith(OBJECT_PREFIX) || objectPath.includes("..")) {
      throw new Error("Invalid object path");
    }
    return objectPath.slice(OBJECT_PREFIX.length);
  }

  private getS3Config(): { client: S3Client; bucket: string } {
    if (!this.s3Client) {
      const bucket = process.env.STORAGE_S3_BUCKET?.trim();
      const region = process.env.STORAGE_S3_REGION?.trim();
      const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID?.trim();
      const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY?.trim();
      if (!bucket || !region || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "S3 storage is not configured. Set STORAGE_S3_BUCKET, STORAGE_S3_REGION, STORAGE_S3_ACCESS_KEY_ID, and STORAGE_S3_SECRET_ACCESS_KEY.",
        );
      }
      const endpoint = process.env.STORAGE_S3_ENDPOINT?.trim();
      this.s3Client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === "true",
        credentials: { accessKeyId, secretAccessKey },
      });
      return { client: this.s3Client, bucket };
    }
    const bucket = process.env.STORAGE_S3_BUCKET?.trim();
    if (!bucket) throw new Error("STORAGE_S3_BUCKET is not configured");
    return { client: this.s3Client, bucket };
  }

  private createLocalUploadToken(payload: LocalUploadToken): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  private verifyLocalUploadToken(token: string): LocalUploadToken {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature || !this.safeEqual(signature, this.sign(encoded))) {
      throw new Error("Invalid or expired upload token");
    }
    let payload: LocalUploadToken;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as LocalUploadToken;
    } catch {
      throw new Error("Invalid upload token");
    }
    if (
      !payload.objectPath ||
      !payload.contentType ||
      !Number.isInteger(payload.size) ||
      payload.expiresAt < Date.now()
    ) {
      throw new Error("Invalid or expired upload token");
    }
    return payload;
  }

  private sign(value: string): string {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error("SESSION_SECRET must be configured");
    return createHmac("sha256", secret).update(value).digest("base64url");
  }

  private safeEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private downloadHeaders(contentType = "application/octet-stream", size?: number): Headers {
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    });
    if (size !== undefined) headers.set("Content-Length", String(size));
    return headers;
  }
}
