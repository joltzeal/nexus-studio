use super::group_store::GroupStore;
use super::profile_store::{PreparedBinary, ProfileStore};

#[test]
fn groups_persist_and_track_real_windows() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("nexus.sqlite");
    let groups = GroupStore::new(database.clone()).unwrap();
    let profiles = ProfileStore::new(root.path().join("profiles"));
    let binary = root.path().join("chrome");
    std::fs::write(&binary, b"binary").unwrap();
    let group = groups.create("Vinted", "欧洲店铺").unwrap();
    let profile = profiles
        .create(
            "Store 1",
            None,
            PreparedBinary {
                version: "145.0.7632.109".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    groups.assign(&profile.id, Some(&group.id)).unwrap();
    assert_eq!(
        GroupStore::new(database.clone()).unwrap().list().unwrap()[0].window_count,
        1
    );
    assert_eq!(
        profiles.group_id(&profile.id).unwrap().as_deref(),
        Some(group.id.as_str())
    );
    groups.update(&group.id, "New name", "备注").unwrap();
    assert_eq!(groups.list().unwrap()[0].name, "New name");
    groups.delete(&group.id).unwrap();
    assert_eq!(profiles.group_id(&profile.id).unwrap(), None);
    assert_eq!(profiles.get(&profile.id).unwrap().name, "Store 1");
}

#[test]
fn assigning_an_unknown_group_preserves_existing_membership() {
    let root = tempfile::tempdir().unwrap();
    let groups = GroupStore::new(root.path().join("nexus.sqlite")).unwrap();
    let profiles = ProfileStore::new(root.path().join("profiles"));
    let binary = root.path().join("chrome");
    std::fs::write(&binary, b"binary").unwrap();
    let group = groups.create("First", "").unwrap();
    let profile = profiles
        .create(
            "One",
            None,
            PreparedBinary {
                version: "145.0.7632.109".into(),
                binary_path: binary,
            },
        )
        .unwrap();
    groups.assign(&profile.id, Some(&group.id)).unwrap();
    assert!(
        groups
            .assign(&profile.id, Some("550e8400-e29b-41d4-a716-446655440000"))
            .is_err()
    );
    assert_eq!(
        profiles.group_id(&profile.id).unwrap().as_deref(),
        Some(group.id.as_str())
    );
}
