#!/usr/bin/env node

/**
 * Migrate local upload files to S3-compatible storage (Cloudflare R2, AWS S3, or any other S3-compatible store).
 *
 * Reads every file from data/uploads/ (with a legacy fallback to public/uploads/)
 * and uploads it to the configured S3 bucket
 * under the "uploads/" prefix. File URLs in the database stay the same (/uploads/filename)
 * because the app's S3 storage driver already handles that mapping.
 *
 * Usage:
 *   S3_BUCKET=bartelby \
 *   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
 *   S3_ACCESS_KEY_ID=... \
 *   S3_SECRET_ACCESS_KEY=... \
 *   S3_REGION=auto \
 *   node scripts/migrate-uploads-to-s3.js [--dry-run] [--verbose]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

// ── Config ───────────────────────────────────────────────────────────────────

const CURRENT_UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const LEGACY_UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
const UPLOADS_DIRS = [CURRENT_UPLOADS_DIR, LEGACY_UPLOADS_DIR];
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION || 'auto';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE || 'false').match(/^(1|true|yes)$/i) !== null;

const UPLOADS_PREFIX = 'uploads/';

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf'
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bartelby: Upload Files → S3 Migration ===\n');

  if (DRY_RUN) {
    console.log('MODE: DRY RUN (no files will be uploaded)\n');
  }

  // Validate
  const existingUploadDirs = UPLOADS_DIRS.filter((dir) => fs.existsSync(dir));
  if (existingUploadDirs.length === 0) {
    console.error(`Uploads directory not found. Checked: ${UPLOADS_DIRS.join(', ')}`);
    process.exit(1);
  }
  if (!BUCKET) {
    console.error('S3_BUCKET environment variable is required.');
    console.error('Required env vars: S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    process.exit(1);
  }
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.');
    process.exit(1);
  }

  // Create S3 client
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT || undefined,
    forcePathStyle: FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY
    }
  });

  console.log(`Source directories: ${existingUploadDirs.join(', ')}`);
  console.log(`Destination: s3://${BUCKET}/${UPLOADS_PREFIX}`);
  if (ENDPOINT) {
    console.log(`Endpoint: ${ENDPOINT}`);
  }
  console.log('');

  // Scan for files
  const files = scanFiles(existingUploadDirs);
  console.log(`Found ${files.length} file(s) to migrate\n`);

  if (files.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // Upload files
  const results = { uploaded: 0, skipped: 0, failed: 0, errors: [] };
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const key = UPLOADS_PREFIX + file.name;

    try {
      // Check if already exists in S3
      const exists = await objectExists(s3, key);
      if (exists) {
        results.skipped++;
        if (VERBOSE) {
          console.log(`  [${i + 1}/${files.length}] SKIP (exists): ${file.name}`);
        }
        continue;
      }

      if (DRY_RUN) {
        results.uploaded++;
        if (VERBOSE) {
          console.log(`  [${i + 1}/${files.length}] WOULD UPLOAD: ${file.name}`);
        }
        continue;
      }

      // Read and upload
      const buffer = fs.readFileSync(file.fullPath);
      const ext = path.extname(file.name).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType
      }));

      results.uploaded++;

      if (VERBOSE) {
        console.log(`  [${i + 1}/${files.length}] OK: ${file.name} (${formatBytes(buffer.length)})`);
      } else if (i % 50 === 0 || i === files.length - 1) {
        process.stdout.write(`\r  Progress: ${i + 1}/${files.length} files...`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ file: file.name, error: err.message });
      console.error(`  [${i + 1}/${files.length}] FAIL: ${file.name} — ${err.message}`);
    }
  }

  if (!VERBOSE && files.length > 0) {
    process.stdout.write('\n');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log('\n=== Migration Summary ===');
  console.log(`  Uploaded: ${results.uploaded}`);
  console.log(`  Skipped (already exists): ${results.skipped}`);
  console.log(`  Failed: ${results.failed}`);
  console.log(`  Time: ${elapsed}s`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of results.errors) {
      console.log(`  - ${e.file}: ${e.error}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(Dry run — no files were actually uploaded)');
  } else if (results.failed === 0) {
    console.log('\nAll files migrated successfully!');
    console.log('Update your .env to set:');
    console.log('  STORAGE_DRIVER=s3');
    console.log(`  S3_BUCKET=${BUCKET}`);
    console.log(`  S3_ENDPOINT=${ENDPOINT || '<your-endpoint>'}`);
    console.log('  S3_ACCESS_KEY_ID=<your-key>');
    console.log('  S3_SECRET_ACCESS_KEY=<your-secret>');
    console.log(`  S3_REGION=${REGION}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function scanFiles(dirs) {
  const files = new Map();
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      if (!files.has(entry)) {
        files.set(entry, { name: entry, fullPath });
      }
    }
  }
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function objectExists(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
