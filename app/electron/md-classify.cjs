'use strict';
/*
 * md-classify.cjs — Muse (Academy Build), main process.
 *
 * Pure classification for markdown routing (design record:
 * Distro files/24 — markdown encountered in the Academy Build
 * opens in MacDown by default). No Electron, no I/O: the router
 * (md-route.cjs) feeds it the download item's filename + MIME and
 * acts on the verdict.
 *
 * A completed download is markdown iff:
 *  - its lowercased extension is .md or .markdown (.mdown is OUT —
 *    MacDown does not declare it either; .txt is OUT — the
 *    plain-text adjacency decision, files/24 section 5b), AND
 *  - its MIME type is not on the binary veto list. Extension is
 *    primary because servers mislabel markdown constantly
 *    (text/plain, application/octet-stream, and empty are all
 *    accepted); the MIME is a veto only, never an admission ticket.
 */

const path = require('node:path');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

// Exact-match vetoes (after normalization: lowercase, parameters
// stripped) — the archive/document formats a ".md" name can hide.
const BINARY_VETO_MIMES = new Set([
  'application/zip',
  'application/pdf',
  'application/x-tar',
  'application/x-gzip',
  'application/gzip',
  'application/x-bzip2',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-compress',
  'application/x-dmg',
  'application/x-iso9660-image',
  'application/x-msdownload',
  'application/vnd.microsoft.portable-executable',
]);

// Whole media families are vetoes: no image, audio, or video
// payload is markdown whatever its filename claims.
const BINARY_VETO_PREFIXES = ['image/', 'audio/', 'video/'];

function fileExtension(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return '';
  return path.parse(path.basename(filename)).ext.toLowerCase();
}

function isMarkdownFilename(filename) {
  return MARKDOWN_EXTENSIONS.has(fileExtension(filename));
}

function normalizeMime(mimeType) {
  if (typeof mimeType !== 'string') return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

function isBinaryVetoMime(mimeType) {
  const mime = normalizeMime(mimeType);
  if (!mime) return false;
  if (BINARY_VETO_MIMES.has(mime)) return true;
  return BINARY_VETO_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function classifyDownload(filename, mimeType) {
  return isMarkdownFilename(filename) && !isBinaryVetoMime(mimeType);
}

module.exports = {
  MARKDOWN_EXTENSIONS,
  BINARY_VETO_MIMES,
  BINARY_VETO_PREFIXES,
  fileExtension,
  isMarkdownFilename,
  normalizeMime,
  isBinaryVetoMime,
  classifyDownload,
};
