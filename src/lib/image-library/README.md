# Private image library

This read-only slice browses existing `creative_assets` with `kind='generated'`.
It reuses the real PostgreSQL PNG `bytea` persistence contract, owned projects,
and optional succeeded generation-job lineage. It creates no assets, accounts,
storage services, credentials, generation requests, sharing rights or migrations.
Project-uploaded references and chat attachments remain in their existing views.

`/images` supports literal title/project/model search, type/stage filters and
cursor pagination. `/images/[id]` shows recorded generation details and the owner's
saved prompt, when lineage exists. Test outputs are labelled. Missing lineage is
reported as not recorded, rather than inferred.

The GET routes are `/api/image-library`, `/api/image-library/[id]` and
`/api/image-library/[id]/file`. File variants are `?variant=thumbnail` (a bounded
512-pixel preview) and `?download=1` (original PNG). The default opens the PNG.
Only same-origin application paths are rendered; raw storage URLs, arbitrary
asset metadata, receipts and credentials are never returned. The native image
element sends the browser's session cookie; the shared Next image optimizer is
deliberately avoided.

Every metadata/file request resolves the existing account session afresh and
every database read constrains both asset and parent-project ownership. File
requests resolve owned metadata first and recheck ownership while reading bytes.
Generation details constrain job and workflow ownership too. All API responses
are private/no-store and vary by Cookie; files use PNG/nosniff/sandbox headers.
Nothing modifies existing authentication settings or global navigation.

Downloads check the current-session response before saving a temporary PNG blob;
authentication, missing, expired and unavailable responses stay visible as errors.
Temporary browser blob URLs are revoked after saving. Preview failures are scoped
to their source, so navigating to another image can recover from a missing file.

Search is at most 80 characters; URLs are at most 2,048 characters. Unknown or
repeated parameters are rejected. Pages default to 12 and cap at 24 images;
keyset cursors preserve microseconds and bind owner and filters. Lists select no
image bytes or prompt bodies. Detail prompts cap at 8,000 characters. Original
images retain the existing 10 MiB/8,388,608-pixel envelope bounds; stored checksum
and dimensions are checked. Thumbnail decoding uses the same pixel bound.
An invalid PNG envelope or undecodable thumbnail returns a private 404; database
failures remain 503. Original downloads preserve stored bytes after envelope and
checksum checks; they are not a full PNG decode or re-encoding operation.

`ImageLibraryStorage` is the small read-only adapter boundary. No database means
explicit unavailable state, never an empty successful library or fabricated
files. Stored database assets have no expiry field and no invented TTL. The
adapter contract also supports an expired file outcome for a future genuinely
expiring store; it returns 410 only after owned metadata is resolved. Missing or
foreign assets return the same 404. There is no persistent preview cache.

The dedicated tests use local PGlite, synthetic PNG fixtures and mock sessions.
No real generation, account, file, remote storage or paid provider is needed.
