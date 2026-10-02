/**
 * Process-level defaults that must be set before anything else loads. Imported first by src/index.ts; the bundled
 * server sets the same defaults in its launcher (dist/index.js) before importing anything.
 *
 * libuv's thread pool (default 4 threads) is created on first use and shared by DNS lookups, async fs, scrypt,
 * zlib and resvg renders; a dozen concurrent knowledge-base fetches queue behind each other on 4 threads (EFF-14).
 */
process.env.UV_THREADPOOL_SIZE ||= "16";
