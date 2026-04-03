/**
 * Shared R2 (Cloudflare) storage helpers.
 * Adapted from PocketSIC — S3-compatible client for Cloudflare R2.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

let _client = null;

function getR2Client() {
  if (_client) return _client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return _client;
}

function getBucket() {
  return process.env.R2_BUCKET || 'saleo';
}

function getPublicUrl() {
  return (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * Convert a public asset URL to its R2 object key.
 * Returns null if the URL doesn't match the R2 public base.
 */
function urlToKey(url) {
  if (!url || typeof url !== 'string') return null;
  const base = getPublicUrl();
  if (!base || !url.startsWith(base)) return null;
  return url.slice(base.length + 1); // +1 for the slash
}

/**
 * Upload an image (base64) to R2 and return the public URL.
 * @param {string} imageBase64
 * @param {string} mimeType
 * @param {string} folder - R2 folder path
 * @param {string} [filename] - Optional custom filename (without extension). If omitted, uses timestamp-random.
 */
async function uploadImage(imageBase64, mimeType, folder, filename) {
  const client = getR2Client();
  if (!client) throw new Error('R2 not configured');

  const bucket = getBucket();
  const baseUrl = getPublicUrl();

  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const name = filename
    ? filename.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
    : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const key = `${folder}/${name}${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(imageBase64, 'base64'),
    ContentType: mimeType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${baseUrl}/${key}`;
}

/**
 * Delete a single R2 object by its public URL.
 * Silently ignores if the URL doesn't match or R2 is not configured.
 */
async function deleteByUrl(url) {
  const key = urlToKey(url);
  if (!key) return;
  const client = getR2Client();
  if (!client) return;

  try {
    await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  } catch (err) {
    console.warn(`[R2] Failed to delete ${key}:`, err.message);
  }
}

/**
 * Delete multiple R2 objects by their public URLs.
 */
async function deleteByUrls(urls) {
  if (!urls || urls.length === 0) return;
  const client = getR2Client();
  if (!client) return;

  const keys = urls.map(urlToKey).filter(Boolean);
  if (keys.length === 0) return;

  try {
    await client.send(new DeleteObjectsCommand({
      Bucket: getBucket(),
      Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
    }));
  } catch (err) {
    console.warn(`[R2] Batch delete failed:`, err.message);
  }
}

/**
 * Extract all R2 asset URLs from an object tree.
 * Walks the object looking for string values that match the R2 public URL.
 */
function extractAssetUrls(obj) {
  const urls = [];
  const base = getPublicUrl();
  if (!base) return urls;

  function walk(val) {
    if (!val) return;
    if (typeof val === 'string' && val.startsWith(base)) {
      urls.push(val);
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  }

  walk(obj);
  return urls;
}

module.exports = {
  getR2Client,
  getBucket,
  getPublicUrl,
  urlToKey,
  uploadImage,
  deleteByUrl,
  deleteByUrls,
  extractAssetUrls,
};
