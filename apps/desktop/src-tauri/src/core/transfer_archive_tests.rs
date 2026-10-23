use super::transfer_archive::{pack, unpack};
use std::fs;

#[test]
fn encrypted_archive_round_trip_preserves_binary_data_and_hides_credentials() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir_all(source.join("profiles/test/user-data/Default")).unwrap();
    fs::write(
        source.join("manifest.json"),
        br#"{"password":"private-password"}"#,
    )
    .unwrap();
    let mut state = 0x1357_2468_u32;
    let bytes: Vec<u8> = (0..1_200_000)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    fs::write(
        source.join("profiles/test/user-data/Default/Cookies"),
        &bytes,
    )
    .unwrap();
    let target = root.path().join("windows.nexuswindow");
    pack(&source, &target, "export-password").unwrap();
    let encrypted = fs::read(&target).unwrap();
    assert!(!encrypted.windows(16).any(|s| s == b"private-password"));
    let destination = root.path().join("destination");
    unpack(&target, &destination, "export-password").unwrap();
    assert_eq!(
        fs::read(destination.join("profiles/test/user-data/Default/Cookies")).unwrap(),
        bytes
    );
}

#[test]
fn long_browser_paths_round_trip_without_losing_the_following_file() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let relative = std::path::PathBuf::from("profiles/test/user-data/Default")
        .join("Storage/ext/IndexedDB")
        .join("https_dashboard.example.test_0.indexeddb.leveldb")
        .join("browser-storage".repeat(12))
        .join("000003.log");
    assert!(relative.to_str().unwrap().len() > 255);
    fs::create_dir_all(source.join(relative.parent().unwrap())).unwrap();
    fs::write(source.join(&relative), b"browser database").unwrap();
    fs::write(source.join("manifest.json"), b"manifest").unwrap();
    let target = root.path().join("windows.nexuswindow");
    pack(&source, &target, "export-password").unwrap();
    let destination = root.path().join("destination");
    unpack(&target, &destination, "export-password").unwrap();
    assert_eq!(
        fs::read(destination.join(relative)).unwrap(),
        b"browser database"
    );
    assert_eq!(
        fs::read(destination.join("manifest.json")).unwrap(),
        b"manifest"
    );
}

#[test]
fn wrong_password_corruption_truncation_and_appended_bytes_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("manifest.json"), b"secret").unwrap();
    let target = root.path().join("windows.nexuswindow");
    pack(&source, &target, "export-password").unwrap();
    assert!(unpack(&target, &root.path().join("wrong"), "wrong-password").is_err());
    let bytes = fs::read(&target).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[60] ^= 1;
    let mut appended = bytes.clone();
    appended.push(1);
    for (name, changed) in [
        ("corrupt", corrupt),
        ("truncated", bytes[..bytes.len() - 1].to_vec()),
        ("appended", appended),
    ] {
        let path = root.path().join(name);
        fs::write(&path, changed).unwrap();
        assert!(
            unpack(
                &path,
                &root.path().join(format!("out-{name}")),
                "export-password"
            )
            .is_err()
        );
    }
}

#[test]
fn short_password_and_replacing_an_existing_archive_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("archive");
    assert!(pack(root.path(), &path, "short").is_err());
    fs::write(&path, b"existing").unwrap();
    assert!(pack(root.path(), &path, "export-password").is_err());
    assert_eq!(fs::read(path).unwrap(), b"existing");
}

#[cfg(unix)]
#[test]
fn archives_never_follow_symlinks_outside_the_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(root.path().join("secret"), b"not-selected").unwrap();
    std::os::unix::fs::symlink(root.path().join("secret"), source.join("link")).unwrap();
    assert!(pack(&source, &root.path().join("archive"), "export-password").is_err());
}
