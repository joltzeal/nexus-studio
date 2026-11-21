use crate::core::browser::provider::{BrowserError, BrowserResult};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub pid: u32,
    started: String,
    #[cfg(unix)]
    group: u32,
}

#[derive(Debug)]
struct Process {
    identity: Identity,
    command: String,
    #[cfg(windows)]
    executable: String,
}

#[derive(Default)]
pub(super) struct Owned {
    pub runner: Option<Identity>,
    pub browser: Option<Identity>,
}

impl Owned {
    pub fn is_empty(&self) -> bool {
        self.runner.is_none() && self.browser.is_none()
    }
}

#[derive(Default)]
pub(super) struct Scan(Option<BrowserResult<Vec<Process>>>);

impl Scan {
    pub fn owned(
        &mut self,
        node: &Path,
        runner: &Path,
        binary: &Path,
        data: &Path,
        token: Option<&str>,
    ) -> BrowserResult<Owned> {
        let processes = self
            .0
            .get_or_insert_with(processes)
            .as_ref()
            .map_err(Clone::clone)?;
        let launch = format!("{} launch {}", runner.display(), data.display());
        let quoted = format!("\"{}\" launch \"{}\"", runner.display(), data.display());
        let data_arg = format!("--user-data-dir={}", data.display());
        let suffix = token.map_or(String::new(), |id| format!(" {id}"));
        let runner_tail = format!(" {launch}{suffix}");
        let token_arg = token.map(|id| format!("--raccoon-session-id={id}"));
        let mut owned = Owned::default();
        for process in processes {
            let command = &process.command;
            let runner_args = command.ends_with(&runner_tail)
                || cfg!(windows) && windows_runner_matches(command, runner, data, &suffix, &quoted);
            let browser_args =
                !command.contains(" --type=") && argument_followed_by_switch(command, &data_arg);
            if browser_args
                && (!executable_matches(process, binary)
                    || token_arg
                        .as_deref()
                        .is_some_and(|arg| !argument_followed_by_switch(command, arg)))
            {
                return Err(uncertain());
            }
            let found = if runner_args {
                if !node_matches(process, node) {
                    return Err(uncertain());
                }
                &mut owned.runner
            } else if browser_args {
                &mut owned.browser
            } else {
                continue;
            };
            if found.replace(process.identity.clone()).is_some() {
                return Err(uncertain());
            }
        }
        Ok(owned)
    }
}

fn windows_runner_matches(
    command: &str,
    runner: &Path,
    data: &Path,
    tail: &str,
    quoted: &str,
) -> bool {
    [
        quoted.to_owned(),
        format!("\"{}\" launch {}", runner.display(), data.display()),
        format!("{} launch \"{}\"", runner.display(), data.display()),
    ]
    .iter()
    .any(|args| command.ends_with(&format!(" {args}{tail}")))
}

#[cfg(unix)]
fn node_matches(process: &Process, node: &Path) -> bool {
    let executable = node.to_string_lossy();
    process
        .command
        .strip_prefix(executable.as_ref())
        .is_some_and(|tail| tail.starts_with(' '))
        || (node == Path::new("node")
            && process
                .command
                .split_whitespace()
                .next()
                .is_some_and(|path| {
                    Path::new(path)
                        .file_name()
                        .is_some_and(|name| name == "node")
                }))
}

#[cfg(windows)]
fn node_matches(process: &Process, node: &Path) -> bool {
    if node == Path::new("node") {
        return Path::new(&process.executable)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"));
    }
    executable_matches(process, node)
}

fn argument_followed_by_switch(command: &str, arg: &str) -> bool {
    command.match_indices(arg).any(|(start, _)| {
        let before = &command[..start];
        let after = &command[start + arg.len()..];
        (before.ends_with(' ') && (after.starts_with(" --") || after.is_empty()))
            || (before.ends_with(" \"") && (after.starts_with("\" ") || after == "\""))
    })
}

#[cfg(unix)]
fn executable_matches(process: &Process, binary: &Path) -> bool {
    process
        .command
        .strip_prefix(binary.to_string_lossy().as_ref())
        .is_some_and(|tail| tail.starts_with(" --"))
}

#[cfg(windows)]
fn executable_matches(process: &Process, binary: &Path) -> bool {
    let binary = binary.to_string_lossy();
    process
        .executable
        .eq_ignore_ascii_case(binary.strip_prefix(r"\\?\").unwrap_or(&binary))
}

#[cfg(unix)]
fn processes() -> BrowserResult<Vec<Process>> {
    let output = Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,pgid=,stat=,lstart=,command="])
        .env("LC_TIME", "C")
        .env("TZ", "UTC")
        .output()
        .map_err(|_| uncertain())?;
    if !output.status.success() {
        return Err(uncertain());
    }
    let mut processes = Vec::new();
    let output = String::from_utf8_lossy(&output.stdout);
    for line in output.lines() {
        if !(line.contains(" launch ") || line.contains("--user-data-dir=")) {
            continue;
        }
        let mut rest = line;
        let Ok(pid) = next_field(&mut rest).parse::<u32>() else {
            continue;
        };
        let group = next_field(&mut rest)
            .parse::<u32>()
            .map_err(|_| uncertain())?;
        if pid <= 1 || next_field(&mut rest).starts_with('Z') {
            continue;
        }
        let started = (0..5)
            .map(|_| next_field(&mut rest))
            .collect::<Vec<_>>()
            .join(" ");
        let command = rest.trim_start().to_owned();
        processes.push(Process {
            identity: Identity {
                pid,
                started,
                group,
            },
            command,
        });
    }
    Ok(processes)
}

#[cfg(unix)]
fn next_field<'a>(rest: &mut &'a str) -> &'a str {
    let remaining = rest.trim_start();
    let end = remaining
        .find(char::is_whitespace)
        .unwrap_or(remaining.len());
    *rest = &remaining[end..];
    &remaining[..end]
}

#[cfg(windows)]
fn processes() -> BrowserResult<Vec<Process>> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        pid: u32,
        started: String,
        executable: Option<String>,
        command: String,
    }

    let output = powershell(
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; \
             ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | \
             Where-Object { $_.CommandLine -match ' launch |--user-data-dir=' -and $_.CommandLine -notmatch ' --type=' } | \
             ForEach-Object { @{pid=$_.ProcessId; started=$_.CreationDate.ToUniversalTime().Ticks.ToString(); \
             executable=$_.ExecutablePath; command=$_.CommandLine} })",
    )?;
    let rows: Vec<Row> = serde_json::from_slice(&output).map_err(|_| uncertain())?;
    Ok(rows
        .into_iter()
        .filter(|row| row.pid > 1)
        .map(|row| Process {
            identity: Identity {
                pid: row.pid,
                started: row.started,
            },
            command: row.command,
            executable: row.executable.unwrap_or_default(),
        })
        .collect())
}

#[cfg(windows)]
fn powershell(script: &str) -> BrowserResult<Vec<u8>> {
    use crate::core::kernel_service::run_preparation;
    use std::{os::windows::process::CommandExt, time::Duration};
    let output = run_preparation(
        Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-Command", script]),
        Duration::from_secs(4),
        None,
    )
    .map_err(|_| uncertain())?;
    if !output.status.success() {
        return Err(uncertain());
    }
    Ok(output.stdout)
}

#[cfg(unix)]
pub(super) fn force_stop(process: &Identity, browser: bool) -> BrowserResult<()> {
    // The caller checks the Profile and launch token. Recheck the OS start time
    // before signaling anything so a recycled PID cannot pass the ownership check.
    if !processes()?.iter().any(|row| &row.identity == process) {
        return Ok(());
    }
    // Playwright detaches Chromium into its own process group on Unix.
    let target = if browser && process.group == process.pid {
        format!("-{}", process.pid)
    } else {
        process.pid.to_string()
    };
    let status = Command::new("/bin/kill")
        .args(["-KILL", "--", &target])
        .output()
        .map_err(|_| uncertain())?
        .status;
    if !status.success() && processes()?.iter().any(|row| &row.identity == process) {
        return Err(uncertain());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn force_stop(process: &Identity, browser: bool) -> BrowserResult<()> {
    let pid = process.pid;
    let started = process.started.parse::<u64>().map_err(|_| uncertain())?;
    let stop = if browser {
        format!("& \"$env:SystemRoot\\System32\\taskkill.exe\" /F /T /PID {pid} | Out-Null")
    } else {
        "$proc.Kill()".into()
    };
    // Keep the handle open through the comparison and termination.
    powershell(&format!(
        "$ErrorActionPreference='Stop'; $proc=Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
         if ($proc) {{ $null=$proc.Handle; $row=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; \
         if ($row -and $row.CreationDate.ToUniversalTime().Ticks -eq {started}) {{ {stop} }} }}"
    ))?;
    Ok(())
}

pub(super) fn uncertain() -> BrowserError {
    BrowserError::new(
        "operation_uncertain",
        "无法确认 CloakBrowser 本机会话已退出，请重新检查 Profile",
    )
}

#[cfg(unix)]
pub(super) fn owns_debugger(process: &Identity, port: u16) -> bool {
    use crate::core::kernel_service::run_preparation;
    use std::time::Duration;
    let lsof = if cfg!(target_os = "macos") {
        "/usr/sbin/lsof"
    } else {
        "/usr/bin/lsof"
    };
    let owned = run_preparation(
        Command::new(lsof).args([
            "-nP",
            "-a",
            "-p",
            &process.pid.to_string(),
            &format!("-iTCP@127.0.0.1:{port}"),
            "-sTCP:LISTEN",
            "-Fp",
        ]),
        Duration::from_secs(3),
        None,
    )
    .is_ok_and(|output| {
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line == format!("p{}", process.pid))
    });
    owned && processes().is_ok_and(|rows| rows.iter().any(|row| &row.identity == process))
}

#[cfg(windows)]
pub(super) fn owns_debugger(process: &Identity, port: u16) -> bool {
    let Ok(started) = process.started.parse::<u64>() else {
        return false;
    };
    let pid = process.pid;
    powershell(&format!(
        "$listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort {port} -State Listen \
         -ErrorAction SilentlyContinue | Where-Object {{ $_.OwningProcess -eq {pid} }}; \
         if ($listener) {{ $row=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; \
         if ($row -and $row.CreationDate.ToUniversalTime().Ticks -eq {started}) {{ 'owned' }} }}"
    ))
    .is_ok_and(|output| String::from_utf8_lossy(&output).trim() == "owned")
}

#[cfg(test)]
mod tests {
    use super::argument_followed_by_switch;

    #[test]
    fn requires_the_entire_profile_argument() {
        let argument = "--user-data-dir=/some path/profile";
        assert!(argument_followed_by_switch(
            "chrome --user-data-dir=/some path/profile --remote-debugging-pipe",
            argument
        ));
        assert!(argument_followed_by_switch(
            "chrome \"--user-data-dir=/some path/profile\" --remote-debugging-pipe",
            argument
        ));
        assert!(!argument_followed_by_switch(
            "chrome --user-data-dir=/some path/profile backup --remote-debugging-pipe",
            argument
        ));
        assert!(!argument_followed_by_switch(
            "chrome --user-data-dir=/some path/profile-copy --remote-debugging-pipe",
            argument
        ));
    }
}
