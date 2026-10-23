use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::num::NonZeroU32;
use std::path::{Component, Path};

const MAGIC: &[u8; 9] = b"NEXUSWIN1";
const CHUNK: usize = 1024 * 1024;
const MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
// Exported files can each have a GNU long name, tar headers and block padding.
const MAX_DECOMPRESSED_BYTES: u64 =
    MAX_BYTES + MAX_FILES as u64 * (MAX_METADATA_BYTES + 3 * 512) + 1024;
const HEADER_SIZE: usize = 49;

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "窗口文件无效、密码错误或文件不完整",
    )
}

struct BoundedReader<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> BoundedReader<R> {
    fn new(inner: R, remaining: u64) -> Self {
        Self { inner, remaining }
    }
}

impl<R: Read> Read for BoundedReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            // A limit must not masquerade as EOF or skip gzip's integrity check.
            return if self.inner.read(&mut [0; 1])? == 0 {
                Ok(0)
            } else {
                Err(invalid())
            };
        }
        let length = self.remaining.min(bytes.len() as u64) as usize;
        let read = self.inner.read(&mut bytes[..length])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

fn password_valid(password: &str) -> io::Result<()> {
    if password.chars().count() < 8 || password.len() > 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "导出密码需要至少 8 个字符",
        ));
    }
    Ok(())
}

fn key(password: &str, salt: &[u8]) -> io::Result<LessSafeKey> {
    let mut bytes = [0; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).ok_or_else(invalid)?,
        salt,
        password.as_bytes(),
        &mut bytes,
    );
    let result = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| invalid());
    bytes.fill(0);
    result.map(LessSafeKey::new)
}

fn nonce(header: &[u8; HEADER_SIZE], index: u32) -> Nonce {
    let mut bytes = [0; 12];
    bytes[..8].copy_from_slice(&header[41..49]);
    bytes[8..].copy_from_slice(&index.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

fn aad(header: &[u8; HEADER_SIZE], index: u32, length: u32) -> Vec<u8> {
    let mut bytes = header.to_vec();
    bytes.extend_from_slice(&index.to_be_bytes());
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes
}

struct EncryptedWriter<W: Write> {
    output: W,
    key: LessSafeKey,
    header: [u8; HEADER_SIZE],
    buffer: Vec<u8>,
    index: u32,
    written: u64,
}

impl<W: Write> EncryptedWriter<W> {
    fn new(mut output: W, password: &str) -> io::Result<Self> {
        let mut header = [0; HEADER_SIZE];
        header[..9].copy_from_slice(MAGIC);
        SystemRandom::new()
            .fill(&mut header[9..])
            .map_err(|_| invalid())?;
        let key = key(password, &header[9..41])?;
        output.write_all(&header)?;
        Ok(Self {
            output,
            key,
            header,
            buffer: Vec::with_capacity(CHUNK),
            index: 0,
            written: 0,
        })
    }

    fn emit(&mut self) -> io::Result<()> {
        let length = self.buffer.len() as u32;
        self.key
            .seal_in_place_append_tag(
                nonce(&self.header, self.index),
                Aad::from(aad(&self.header, self.index, length)),
                &mut self.buffer,
            )
            .map_err(|_| invalid())?;
        self.output.write_all(&length.to_be_bytes())?;
        self.output.write_all(&self.buffer)?;
        self.buffer.clear();
        self.index = self.index.checked_add(1).ok_or_else(invalid)?;
        Ok(())
    }

    fn finish(mut self) -> io::Result<W> {
        if !self.buffer.is_empty() {
            self.emit()?;
        }
        // The authenticated empty frame is mandatory: EOF alone is never success.
        self.emit()?;
        self.output.flush()?;
        Ok(self.output)
    }
}

impl<W: Write> Write for EncryptedWriter<W> {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let size = bytes.len();
        self.written = self.written.checked_add(size as u64).ok_or_else(invalid)?;
        if self.written > MAX_BYTES {
            return Err(invalid());
        }
        while !bytes.is_empty() {
            let length = bytes.len().min(CHUNK - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..length]);
            bytes = &bytes[length..];
            if self.buffer.len() == CHUNK {
                self.emit()?;
            }
        }
        Ok(size)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

fn decrypt(
    input: &mut File,
    output: &mut File,
    password: &str,
    max_compressed_bytes: u64,
) -> io::Result<()> {
    let mut header = [0; HEADER_SIZE];
    input.read_exact(&mut header).map_err(|_| invalid())?;
    if &header[..9] != MAGIC {
        return Err(invalid());
    }
    let key = key(password, &header[9..41])?;
    let mut total = 0u64;
    for index in 0..u32::MAX {
        let mut length = [0; 4];
        input.read_exact(&mut length).map_err(|_| invalid())?;
        let length = u32::from_be_bytes(length);
        if length as usize > CHUNK {
            return Err(invalid());
        }
        let mut bytes = vec![0; length as usize + 16];
        input.read_exact(&mut bytes).map_err(|_| invalid())?;
        let plain = key
            .open_in_place(
                nonce(&header, index),
                Aad::from(aad(&header, index, length)),
                &mut bytes,
            )
            .map_err(|_| invalid())?;
        if length == 0 {
            if input.read(&mut [0; 1])? != 0 {
                return Err(invalid());
            }
            output.seek(SeekFrom::Start(0))?;
            return Ok(());
        }
        total += u64::from(length);
        if total > max_compressed_bytes {
            return Err(invalid());
        }
        output.write_all(plain)?;
    }
    Err(invalid())
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|part| {
            matches!(part, Component::Normal(value) if value.to_str().is_some_and(|s| !s.contains(['\\', ':']) && s != "."))
        })
}

fn append_tree<W: Write>(
    archive: &mut tar::Builder<W>,
    root: &Path,
    directory: &Path,
    count: &mut usize,
    bytes: &mut u64,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            append_tree(archive, root, &entry.path(), count, bytes)?;
        } else if file_type.is_file() {
            *count += 1;
            let metadata = entry.metadata()?;
            *bytes += metadata.len();
            if *count > MAX_FILES || *bytes > MAX_BYTES {
                return Err(invalid());
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|_| invalid())?;
            if !safe_relative(relative) {
                return Err(invalid());
            }
            let mut header = tar::Header::new_gnu();
            header.set_size(metadata.len());
            header.set_mode(0o600);
            header.set_cksum();
            archive.append_data(&mut header, relative, File::open(&path)?)?;
        } else {
            return Err(invalid());
        }
    }
    Ok(())
}

pub fn pack(source: &Path, target: &Path, password: &str) -> io::Result<()> {
    password_valid(password)?;
    if target.exists() || target.starts_with(source) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "目标文件已存在，请选择新的文件名",
        ));
    }
    let parent = target.parent().ok_or_else(invalid)?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let writer = EncryptedWriter::new(temporary.reopen()?, password)?;
    let compressor = GzEncoder::new(writer, Compression::default());
    let mut archive = tar::Builder::new(compressor);
    append_tree(&mut archive, source, source, &mut 0, &mut 0)?;
    let writer = archive.into_inner()?.finish()?;
    writer.finish()?.sync_all()?;
    temporary
        .persist_noclobber(target)
        .map_err(|error| error.error)?;
    Ok(())
}

fn max_encoded_bytes(max_compressed_bytes: u64) -> io::Result<u64> {
    // Each data frame and the mandatory empty final frame carry a length and GCM tag.
    let overhead = max_compressed_bytes
        .div_ceil(CHUNK as u64)
        .checked_add(1)
        .and_then(|frames| frames.checked_mul(4 + 16))
        .and_then(|bytes| bytes.checked_add(HEADER_SIZE as u64))
        .ok_or_else(invalid)?;
    max_compressed_bytes
        .checked_add(overhead)
        .ok_or_else(invalid)
}

pub fn unpack(source: &Path, destination: &Path, password: &str) -> io::Result<()> {
    unpack_with_compressed_limit(source, destination, password, MAX_BYTES)
}

fn unpack_with_compressed_limit(
    source: &Path,
    destination: &Path,
    password: &str,
    max_compressed_bytes: u64,
) -> io::Result<()> {
    password_valid(password)?;
    if destination.exists() {
        return Err(invalid());
    }
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.len() > max_encoded_bytes(max_compressed_bytes)? {
        return Err(invalid());
    }
    let mut compressed = tempfile::tempfile()?;
    decrypt(
        &mut File::open(source)?,
        &mut compressed,
        password,
        max_compressed_bytes,
    )?;
    unpack_compressed(
        compressed,
        destination,
        MAX_DECOMPRESSED_BYTES,
        MAX_METADATA_BYTES,
    )
}

fn validate_tar<R: Read>(reader: R, max_metadata_bytes: u64) -> io::Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut count = 0usize;
    let mut total = 0u64;
    let mut metadata_count = 0usize;
    let mut pax_size = None;
    // Normal iteration allocates GNU/PAX payloads before returning an entry.
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_file() {
            count += 1;
            total = total.checked_add(entry.size()).ok_or_else(invalid)?;
            if count > MAX_FILES
                || total > MAX_BYTES
                // Keep raw validation and extraction on identical header boundaries.
                || pax_size.take().is_some_and(|size| size != entry.size())
            {
                return Err(invalid());
            }
            metadata_count = 0;
        } else if kind.is_gnu_longname() || kind.is_gnu_longlink() || kind.is_pax_local_extensions()
        {
            metadata_count += 1;
            if metadata_count > 3
                || entry.size() > max_metadata_bytes
                || (entry.header().as_gnu().is_none() && entry.header().as_ustar().is_none())
            {
                return Err(invalid());
            }
            if kind.is_pax_local_extensions() {
                for extension in entry.pax_extensions()?.ok_or_else(invalid)? {
                    let extension = extension?;
                    if extension.key_bytes() == b"size" {
                        let size = extension
                            .value()
                            .map_err(|_| invalid())?
                            .parse::<u64>()
                            .map_err(|_| invalid())?;
                        if pax_size.replace(size).is_some() {
                            return Err(invalid());
                        }
                    }
                }
            }
        } else {
            return Err(invalid());
        }
    }
    if metadata_count != 0 {
        return Err(invalid());
    }
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    Ok(())
}

fn unpack_compressed<R: Read + Seek>(
    mut compressed: R,
    destination: &Path,
    max_decompressed_bytes: u64,
    max_metadata_bytes: u64,
) -> io::Result<()> {
    // The decrypted temporary file is private and unchanged between both passes.
    validate_tar(
        BoundedReader::new(GzDecoder::new(&mut compressed), max_decompressed_bytes),
        max_metadata_bytes,
    )?;
    compressed.rewind()?;
    fs::create_dir_all(destination)?;
    let result = (|| {
        let mut archive = tar::Archive::new(BoundedReader::new(
            GzDecoder::new(compressed),
            max_decompressed_bytes,
        ));
        let mut count = 0usize;
        let mut total = 0u64;
        for entry in archive.entries()? {
            let mut entry = entry?;
            count += 1;
            total = total.checked_add(entry.size()).ok_or_else(invalid)?;
            if count > MAX_FILES || total > MAX_BYTES || !entry.header().entry_type().is_file() {
                return Err(invalid());
            }
            let relative = entry.path()?.into_owned();
            if !safe_relative(&relative) {
                return Err(invalid());
            }
            let target = destination.join(relative);
            fs::create_dir_all(target.parent().ok_or_else(invalid)?)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(target)?;
            io::copy(&mut entry, &mut file)?;
        }
        // The same budget covers all bytes after tar's end marker and gzip's trailer.
        io::copy(&mut archive.into_inner(), &mut io::sink())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append_file(archive: &mut tar::Builder<Vec<u8>>, name: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive.append_data(&mut header, name, bytes).unwrap();
    }

    fn append_metadata(archive: &mut tar::Builder<Vec<u8>>, kind: tar::EntryType, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(bytes.len() as u64);
        header.set_cksum();
        archive.append(&header, bytes).unwrap();
    }

    fn compressed_tar(append: impl FnOnce(&mut tar::Builder<Vec<u8>>), trailer: &[u8]) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        append(&mut archive);
        let mut bytes = archive.into_inner().unwrap();
        bytes.extend_from_slice(trailer);
        let mut compressor = GzEncoder::new(Vec::new(), Compression::default());
        compressor.write_all(&bytes).unwrap();
        compressor.finish().unwrap()
    }

    #[test]
    fn encoded_budget_covers_data_frames_and_the_authenticated_terminator() {
        for (length, expected_encoded) in [
            (0, 69),
            (1, 90),
            (CHUNK as u64, CHUNK as u64 + 89),
            (CHUNK as u64 + 1, CHUNK as u64 + 110),
        ] {
            let mut writer = EncryptedWriter::new(Vec::new(), "transfer-password").unwrap();
            io::copy(&mut io::repeat(0).take(length), &mut writer).unwrap();
            let encrypted = writer.finish().unwrap();
            assert_eq!(encrypted.len() as u64, expected_encoded);
            assert_eq!(max_encoded_bytes(length).unwrap(), expected_encoded);
        }
    }

    #[test]
    fn archives_at_the_compressed_limit_allow_their_encoded_overhead() {
        let root = tempfile::tempdir().unwrap();
        let compressed = compressed_tar(
            |archive| append_file(archive, "manifest.json", b"secret"),
            &[],
        );
        let path = root.path().join("archive");
        let mut writer =
            EncryptedWriter::new(File::create(&path).unwrap(), "transfer-password").unwrap();
        writer.write_all(&compressed).unwrap();
        writer.finish().unwrap();
        assert!(path.metadata().unwrap().len() > compressed.len() as u64);
        let destination = root.path().join("out");
        unpack_with_compressed_limit(
            &path,
            &destination,
            "transfer-password",
            compressed.len() as u64,
        )
        .unwrap();
        assert_eq!(
            fs::read(destination.join("manifest.json")).unwrap(),
            b"secret"
        );
        let destination = root.path().join("too-small");
        assert!(
            unpack_with_compressed_limit(
                &path,
                &destination,
                "transfer-password",
                compressed.len() as u64 - 1,
            )
            .is_err()
        );
        assert!(!destination.exists());
    }

    #[test]
    fn gnu_and_pax_metadata_are_capped_before_extraction() {
        let root = tempfile::tempdir().unwrap();
        for (index, kind) in [
            tar::EntryType::GNULongName,
            tar::EntryType::GNULongLink,
            tar::EntryType::XHeader,
        ]
        .into_iter()
        .enumerate()
        {
            let compressed = compressed_tar(
                |archive| {
                    if kind.is_pax_local_extensions() {
                        archive
                            .append_pax_extensions([("comment", &[b'a'; 200][..])])
                            .unwrap();
                    } else {
                        let mut name = vec![b'a'; 200];
                        name.push(0);
                        append_metadata(archive, kind, &name);
                    }
                    append_file(archive, "manifest.json", b"secret");
                },
                &[],
            );
            let destination = root.path().join(format!("out-{index}"));
            let result = unpack_compressed(io::Cursor::new(compressed), &destination, 8192, 128);
            assert!(
                result.is_err(),
                "{kind:?} metadata larger than its limit was accepted"
            );
            assert!(!destination.exists());
        }
    }

    #[test]
    fn oversized_metadata_is_rejected_without_reading_its_declared_payload() {
        struct HeaderOnly<'a>(&'a [u8]);
        impl Read for HeaderOnly<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                assert!(!self.0.is_empty(), "metadata payload must not be read");
                self.0.read(bytes)
            }
        }
        for kind in [
            tar::EntryType::GNULongName,
            tar::EntryType::GNULongLink,
            tar::EntryType::XHeader,
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_size(1024 * 1024 * 1024);
            header.set_cksum();
            let error = validate_tar(HeaderOnly(header.as_bytes()), 128).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{kind:?}");
        }
    }

    #[test]
    fn decompressed_file_reads_include_tar_headers_in_the_budget() {
        let root = tempfile::tempdir().unwrap();
        let compressed = compressed_tar(|archive| append_file(archive, "Cookies", &[0; 4096]), &[]);
        let destination = root.path().join("out");
        assert!(unpack_compressed(io::Cursor::new(compressed), &destination, 4096, 128).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn decompressed_trailer_reads_cannot_exceed_the_budget() {
        let root = tempfile::tempdir().unwrap();
        let compressed = compressed_tar(
            |archive| append_file(archive, "manifest.json", b"secret"),
            &[0; 8192],
        );
        assert!(compressed.len() < 4096);
        let destination = root.path().join("out");
        assert!(unpack_compressed(io::Cursor::new(compressed), &destination, 4096, 128).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn exact_decompressed_limit_accepts_eof_but_rejects_one_more_byte() {
        let root = tempfile::tempdir().unwrap();
        let compressed = compressed_tar(
            |archive| append_file(archive, "manifest.json", b"secret"),
            &[],
        );
        let destination = root.path().join("exact");
        unpack_compressed(io::Cursor::new(&compressed), &destination, 2048, 128).unwrap();
        assert_eq!(
            fs::read(destination.join("manifest.json")).unwrap(),
            b"secret"
        );
        let destination = root.path().join("short");
        assert!(unpack_compressed(io::Cursor::new(compressed), &destination, 2047, 128).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn gzip_integrity_is_checked_even_at_the_exact_decompressed_limit() {
        let root = tempfile::tempdir().unwrap();
        let compressed = compressed_tar(
            |archive| append_file(archive, "manifest.json", b"secret"),
            &[],
        );
        let mut corrupt = compressed.clone();
        let crc = corrupt.len() - 8;
        corrupt[crc] ^= 1;
        for (name, bytes) in [
            ("corrupt", corrupt),
            ("truncated", compressed[..compressed.len() - 4].to_vec()),
        ] {
            let destination = root.path().join(name);
            assert!(unpack_compressed(io::Cursor::new(bytes), &destination, 2048, 128).is_err());
            assert!(!destination.exists());
        }
    }

    #[test]
    fn pax_size_overrides_cannot_hide_oversized_metadata_from_validation() {
        let root = tempfile::tempdir().unwrap();
        let mut hidden = tar::Builder::new(Vec::new());
        append_metadata(&mut hidden, tar::EntryType::GNULongLink, &[b'a'; 200]);
        let hidden = hidden.into_inner().unwrap();
        let compressed = compressed_tar(
            |archive| {
                archive
                    .append_pax_extensions([("size", &b"0"[..])])
                    .unwrap();
                append_file(archive, "empty", &hidden[..1024]);
                append_file(archive, "manifest.json", b"secret");
            },
            &[],
        );
        let destination = root.path().join("out");
        assert!(unpack_compressed(io::Cursor::new(compressed), &destination, 8192, 128).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn bounded_pax_paths_and_matching_size_overrides_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let relative = format!(
            "profiles/test/user-data/Default/{}/Cookies",
            "site".repeat(40)
        );
        let compressed = compressed_tar(
            |archive| {
                archive
                    .append_pax_extensions([("path", relative.as_bytes()), ("size", &b"6"[..])])
                    .unwrap();
                append_file(archive, "placeholder", b"secret");
            },
            &[],
        );
        let destination = root.path().join("out");
        unpack_compressed(io::Cursor::new(compressed), &destination, 8192, 1024).unwrap();
        assert_eq!(fs::read(destination.join(relative)).unwrap(), b"secret");
        assert!(!destination.join("placeholder").exists());
    }

    #[test]
    fn authenticated_archives_still_reject_path_traversal_and_links() {
        let root = tempfile::tempdir().unwrap();
        for (index, name, kind) in [
            (0, "../escaped", tar::EntryType::Regular),
            (1, "/absolute", tar::EntryType::Regular),
            (2, "profiles/link", tar::EntryType::Symlink),
            (3, "C:\\escaped", tar::EntryType::Regular),
            (4, "profiles/hardlink", tar::EntryType::Link),
            (
                5,
                "profiles/test/user-data/Last Browser",
                tar::EntryType::Symlink,
            ),
            (
                6,
                "profiles/test/user-data/RunningChromeVersion",
                tar::EntryType::Symlink,
            ),
        ] {
            let path = root.path().join(format!("archive-{index}"));
            let writer =
                EncryptedWriter::new(File::create(&path).unwrap(), "transfer-password").unwrap();
            let mut archive = tar::Builder::new(GzEncoder::new(writer, Compression::default()));
            let mut header = tar::Header::new_gnu();
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            header.set_size(0);
            header.set_mode(0o600);
            header.set_entry_type(kind);
            if matches!(kind, tar::EntryType::Symlink | tar::EntryType::Link) {
                header.set_link_name("../../../escaped").unwrap();
            }
            header.set_cksum();
            archive.append(&header, io::empty()).unwrap();
            archive
                .into_inner()
                .unwrap()
                .finish()
                .unwrap()
                .finish()
                .unwrap();
            let destination = root.path().join(format!("out-{index}"));
            assert!(unpack(&path, &destination, "transfer-password").is_err());
            assert!(!destination.exists());
        }
        assert!(!root.path().join("escaped").exists());
    }
}
