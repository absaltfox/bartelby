#!/usr/bin/env node

/**
 * Document Import Utility
 *
 * Scans a directory for images, sends them to an LLM for transcription,
 * and imports them into the database.
 *
 * Usage:
 *   node utils/import.js <import-directory> [options]
 *
 * Options:
 *   --provider <name>    LLM provider to use (default: openai)
 *   --transcriber <name> Name to use as transcriber (default: "AI Transcription")
 *   --dry-run            Show what would be imported without making changes
 *   --verbose            Show detailed output
 */

const fs = require('fs');
const path = require('path');
const { createProvider, listProviders } = require('./llm');
const { initializeSchema, documents, transcripts, saveDatabase } = require('../database/db');

// Supported image formats
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

// MIME types for extensions
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff'
};

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    importDir: null,
    provider: 'openai',
    transcriber: 'AI Transcription',
    dryRun: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--provider' && args[i + 1]) {
      options.provider = args[++i];
    } else if (arg === '--transcriber' && args[i + 1]) {
      options.transcriber = args[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      options.importDir = arg;
    }
  }

  return options;
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Document Import Utility

Scans a directory for images, transcribes them using an LLM, and imports
them into the Historical Document Transcriber database.

Usage:
  node utils/import.js <import-directory> [options]
  npm run import -- <import-directory> [options]

Options:
  --provider <name>    LLM provider to use (default: openai)
                       Available: ${listProviders().join(', ')}
  --transcriber <name> Name to record as transcriber (default: "AI Transcription")
  --dry-run            Show what would be imported without making changes
  --verbose, -v        Show detailed output
  --help, -h           Show this help message

Environment Variables:
  OPENAI_API_KEY       Required for OpenAI provider

Examples:
  node utils/import.js ./documents-to-import
  node utils/import.js ./scans --provider openai --verbose
  node utils/import.js ./images --dry-run
`);
}

/**
 * Find all image files in a directory
 */
function findImages(dir) {
  const images = [];

  if (!fs.existsSync(dir)) {
    throw new Error(`Import directory does not exist: ${dir}`);
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        images.push({
          path: fullPath,
          name: entry.name,
          ext: ext,
          mimeType: MIME_TYPES[ext]
        });
      }
    } else if (entry.isDirectory()) {
      // Recursively scan subdirectories
      images.push(...findImages(fullPath));
    }
  }

  return images;
}

/**
 * Copy image to public/uploads directory
 */
function copyImageToUploads(sourcePath, filename) {
  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

  // Ensure uploads directory exists
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Generate unique filename if needed
  let destFilename = filename;
  let destPath = path.join(uploadsDir, destFilename);
  let counter = 1;

  while (fs.existsSync(destPath)) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    destFilename = `${base}_${counter}${ext}`;
    destPath = path.join(uploadsDir, destFilename);
    counter++;
  }

  fs.copyFileSync(sourcePath, destPath);

  return `/uploads/${destFilename}`;
}

/**
 * Import a single document
 */
async function importDocument(image, provider, transcriber, options) {
  const { dryRun, verbose } = options;

  if (verbose) {
    console.log(`  Reading image: ${image.path}`);
  }

  // Read image file
  const imageBuffer = fs.readFileSync(image.path);

  if (verbose) {
    console.log(`  Sending to ${provider.name} for transcription...`);
  }

  // Get transcription from LLM
  const result = await provider.transcribeDocument(imageBuffer, image.mimeType);

  if (verbose) {
    console.log(`  Received transcription (${result.transcription.length} chars)`);
    console.log(`  Metadata:`, result.metadata);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would import:`);
    console.log(`    Title: ${result.metadata.title || image.name}`);
    console.log(`    Date: ${result.metadata.date_created || 'Unknown'}`);
    console.log(`    Transcription: ${result.transcription.substring(0, 100)}...`);
    return { success: true, dryRun: true };
  }

  // Copy image to uploads
  const imagePath = copyImageToUploads(image.path, image.name);

  if (verbose) {
    console.log(`  Copied image to: ${imagePath}`);
  }

  // Build document record
  const docData = {
    title: result.metadata.title || path.basename(image.name, image.ext),
    date_created: result.metadata.date_created || null,
    description: buildDescription(result.metadata),
    image_path: imagePath,
    metadata: result.metadata
  };

  // Insert document
  const docId = documents.create(docData);

  if (verbose) {
    console.log(`  Created document ID: ${docId}`);
  }

  // Insert transcript
  const transcriptId = transcripts.create({
    document_id: docId,
    content: result.transcription,
    transcriber: transcriber,
    version: 1,
    notes: result.notes
  });

  if (verbose) {
    console.log(`  Created transcript ID: ${transcriptId}`);
  }

  return {
    success: true,
    documentId: docId,
    transcriptId: transcriptId,
    title: docData.title
  };
}

/**
 * Build a description from metadata
 */
function buildDescription(metadata) {
  const parts = [];

  if (metadata.document_type) {
    parts.push(metadata.document_type);
  }

  if (metadata.author) {
    parts.push(`by ${metadata.author}`);
  }

  if (metadata.location) {
    parts.push(`from ${metadata.location}`);
  }

  if (metadata.condition) {
    parts.push(`Condition: ${metadata.condition}`);
  }

  return parts.join('. ') || null;
}

/**
 * Main import function
 */
async function main() {
  const options = parseArgs();

  if (!options.importDir) {
    console.error('Error: Import directory is required.\n');
    showHelp();
    process.exit(1);
  }

  // Resolve to absolute path
  options.importDir = path.resolve(options.importDir);

  console.log('Document Import Utility');
  console.log('=======================\n');
  console.log(`Import directory: ${options.importDir}`);
  console.log(`LLM Provider: ${options.provider}`);
  console.log(`Transcriber: ${options.transcriber}`);
  if (options.dryRun) {
    console.log('Mode: DRY RUN (no changes will be made)\n');
  }
  console.log('');

  // Initialize database
  console.log('Initializing database...');
  await initializeSchema();

  // Create LLM provider
  console.log(`Initializing ${options.provider} provider...`);
  let provider;
  try {
    provider = createProvider(options.provider);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Find images
  console.log('Scanning for images...');
  const images = findImages(options.importDir);
  console.log(`Found ${images.length} image(s)\n`);

  if (images.length === 0) {
    console.log('No images found to import.');
    process.exit(0);
  }

  // Process each image
  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    console.log(`[${i + 1}/${images.length}] Processing: ${image.name}`);

    try {
      const result = await importDocument(image, provider, options.transcriber, options);
      results.success++;

      if (!options.dryRun) {
        console.log(`  ✓ Imported: ${result.title}\n`);
      } else {
        console.log('');
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ file: image.name, error: err.message });
      console.error(`  ✗ Error: ${err.message}\n`);
    }
  }

  // Save database
  if (!options.dryRun) {
    saveDatabase();
  }

  // Summary
  console.log('Import Complete');
  console.log('===============');
  console.log(`Successful: ${results.success}`);
  console.log(`Failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.forEach(e => {
      console.log(`  - ${e.file}: ${e.error}`);
    });
  }

  if (!options.dryRun && results.success > 0) {
    console.log('\nDocuments are now available in the web application.');
    console.log('Run `npm start` and visit http://localhost:3000 to view them.');
  }
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
