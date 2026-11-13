# Products plugin

`studio.products` 1.0.0 provides the `product.catalog` capability for Raccoon
0.1.29 and later. The manifest requests private storage and no network, browser,
or secret permissions. This trusted Node process is not a security sandbox.
It performs no platform publishing, Agent execution, or browser automation.

## Entry points

The package exports `createProductsPlugin`, `startProductsPlugin`,
`createFileStore`, and `createMemoryStore`. Production uses
`NEXUS_PLUGIN_STORAGE_DIR`; tests can inject a store, clock, streams, and
diagnostics. A memory store reports `storageDurable: false`.

`createProductsPlugin(options)` returns `{ plugin, store, server, stop }`.
`plugin.call(context)` is the business entry point; `startProductsPlugin`
also starts the line-delimited RPC server. Public request and response schemas
and the complete method list are in `src/contracts.ts`.

| Method                    | Result                                                       |
| ------------------------- | ------------------------------------------------------------ |
| `products.list`           | Filtered, clamped, 1-based page of summaries, 20 or 50 items |
| `products.get`            | `{ product }`                                                |
| `products.save`           | `{ product, alreadySaved }`                                  |
| `products.remove`         | `{ id, removed }`                                            |
| `products.import`         | `{ total, inserted, skipped, errors }`                       |
| `products.sources.find`   | `{ product: Product \| null }`                               |
| `products.importAi`       | `{ product, alreadyImported }`                               |
| `products.upload.begin`   | `{ uploadId, chunkSize }`                                    |
| `products.upload.chunk`   | `{ accepted: true }`                                         |
| `products.upload.finish`  | `{ image }`                                                  |
| `products.upload.abort`   | `{ aborted }`                                                |
| `products.images.read`    | `{ data, next, done, total }`                                |
| `products.images.discard` | `{ removed }`                                                |

Drafts require a name and may omit category and other listing fields. A ready
product requires title, description, price, condition, and owned images.
Products have stable UUIDs, monotonically increasing revisions, and a durable
creation sequence. Filters run before paging; ordering uses descending creation
sequence even when timestamps are equal. Summaries omit description and note
and expose only the cover and image count.

Creation uses a durable `createKey` receipt. Edits and deletes check
`expectedRevision` within the write queue. A repeated creation returns the
current product and never overwrites edits. A deleted creation cannot replay
as success. Revision conflicts and deleted receipt retries use
`INVALID_REQUEST`; filesystem failures use `UNAVAILABLE`.

## Storage and images

`products.json` is a versioned, validated plaintext document containing
products, image metadata, the next creation sequence, and idempotency receipts.
It is limited to 64 MiB. Images are owned copies in `images/<uuid>.bin`;
names received from callers are display labels and never filesystem paths.
The plugin does not read AI history, another plugin's files, or SQLite.

Writes use a serial queue, document copies, exclusive temporary files, file
sync, and atomic rename. Memory changes only after document commit.
Cancellation and deadline guards run within queued operations and immediately
before publication. Corrupt documents and missing or changed image bytes
produce explicit errors without resetting data. Reads verify file type, size,
SHA-256, and MIME signature; private roots, document files, image directories,
and image files reject symbolic links.

An image is written before its metadata is committed. A failed metadata commit
removes the unpublished bytes. Product edits, deletes, and explicit discard
remove image metadata only when no product references it. Physical cleanup
runs after the document commit under the same queue. A cleanup failure can
leave an unreferenced file; it cannot roll back a committed product deletion
or remove a different product's reference.

Uploads allow PNG, JPEG, and WebP up to 8 MiB each, in ordered chunks of
192 KiB with a shorter final chunk. Base64 must be canonical; actual signatures
must match the declared MIME. There are at most four active sessions, each
expiring five minutes after creation. Abort and process stop invalidate queued
upload commits. Upload sessions are ephemeral; finished images and their exact
byte hashes survive restart.

Finishing an upload atomically commits its image metadata and a durable
`uploadId` to `imageId` receipt. Retrying finish returns the same image, including
after restart, until that image is committed to a product or discarded.
Aborting a completed upload can reclaim its unreferenced image when the finish
reply was lost. Product commit clears the upload's cleanup authority in the
same transaction, so a late abort cannot remove a product image. Removing an
unused image also clears its receipt.

## Imports

AI import receives metadata and image IDs already uploaded into this plugin.
A durable `recordId` receipt deduplicates concurrent imports and restarts.
Retry returns the current hand-edited product. Source lookup returns `null`
after deletion; retrying the deleted import fails rather than recreating it.
Origin metadata is descriptive and is never fetched.

File import accepts an RFC 4180 CSV with a header, optional UTF-8 BOM, and
English or Chinese field aliases, or a JSON array of metadata objects. Each
request allows at most 1000 data rows and 512 KiB of UTF-8 content. The supported
fields are `name`, `title`, `description`, `sku`, `price`, `currency`,
`category`, `condition`, `brand`, `size`, `tags`, `note`, and `status`.
CSV tags can use semicolons, commas, pipes, or a quoted JSON array.
An empty CSV price becomes `null`; currency defaults to USD.

Image IDs, image URLs, local paths, product IDs, and revisions are not imported.
No image URLs are downloaded. Invalid rows appear in `errors`; `skipped`
includes invalid and duplicate rows, so `inserted + skipped === total`.
Malformed files and over-limit requests fail before any write.
All valid rows and their receipts commit together.

The normalized file content and logical row identify an import receipt.
Only that durable source row key deduplicates a file import. SKU is ordinary,
nonunique metadata: distinct rows and files can create separate products with
the same SKU. Reimporting the same file still skips its recorded rows, including
after edits or deletion, and never updates another product.

## Local verification

Use the repository's fixed Node and invoke Vitest directly:

```sh
rtk proxy /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/vitest/vitest.mjs run plugins/products/src/backend.test.ts plugins/products/src/import.test.ts plugins/products/src/rpc/server.test.ts
rtk proxy /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/typescript/bin/tsc -p plugins/products/tsconfig.json --noEmit
rtk proxy /Users/ameno/.nvm/versions/node/v24.18.0/bin/node node_modules/eslint/bin/eslint.js plugins/products --max-warnings 0
```

Tests use real temporary directories for restart, integrity, rollback, missing
files, and symlink checks, plus actual RPC streams for handshake, cancellation,
deadlines, permissions, and response size limits. These checks do not establish
Windows, signed-package, Rust, or production installation validation.
