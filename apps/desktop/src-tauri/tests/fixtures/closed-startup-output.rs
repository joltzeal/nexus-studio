use std::io;
use std::time::Duration;

#[cfg(unix)]
fn close_stdout() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // This isolated fixture never uses stdout again after taking ownership.
    drop(unsafe { OwnedFd::from_raw_fd(io::stdout().as_raw_fd()) });
}

#[cfg(windows)]
fn close_stdout() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    // Close the actual pipe handle; Node's fs.closeSync(1) is a no-op on Windows.
    drop(unsafe { OwnedHandle::from_raw_handle(io::stdout().as_raw_handle()) });
}

fn main() {
    let marker = std::env::args_os().nth(1).expect("missing marker path");
    let mut configuration = String::new();
    io::stdin().read_line(&mut configuration).unwrap();
    assert!(!configuration.trim().is_empty());
    std::fs::write(marker, b"configuration received").unwrap();
    close_stdout();

    // Keep stderr open so a host that waits without killing us fails the test.
    std::thread::sleep(Duration::from_secs(7));
}
