use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

struct Srv {
    child: Child,
    port: u16,
    token: String,
    base: PathBuf,
}

impl Drop for Srv {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn start(tag: &str, setup: impl FnOnce(&Path, &Path)) -> Srv {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let base = std::env::temp_dir().join(format!("pr-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    setup(&root, &outside);
    let mut child = Command::new(env!("CARGO_BIN_EXE_pointer-retrieval"))
        .args(["--root", root.to_str().unwrap(), "--exit-with-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let parts: Vec<&str> = line.split_whitespace().collect();
    assert_eq!(parts[0], "READY", "bad ready line: {line}");
    let port = parts[1]
        .trim_start_matches("http://127.0.0.1:")
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    Srv {
        child,
        port,
        token: parts[2].to_string(),
        base,
    }
}

fn rpc(s: &Srv, body: &str) -> String {
    let mut c = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
    c.set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    write!(
        c,
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        s.token,
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    let _ = c.read_to_string(&mut out);
    out.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
}

fn call(s: &Srv, tool: &str, args: &str) -> String {
    let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
    assert!(rpc(s, init).contains("protocolVersion"));
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"{tool}","arguments":{args}}}}}"#
    );
    rpc(s, &body)
}

fn everything(s: &Srv, queries: &[&str]) -> String {
    let mut all = call(s, "repo_map", r#"{"budget_tokens":5000}"#);
    for q in queries {
        all.push_str(&call(
            s,
            "search_codebase",
            &format!(r#"{{"query":"{q}","budget_tokens":5000}}"#),
        ));
        all.push_str(&call(s, "find_symbol", &format!(r#"{{"name":"{q}"}}"#)));
    }
    all
}

fn plant(r: &Path, name: &str, marker: &str) {
    let p = r.join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, format!("def {marker}():\n    return 'PAYLOAD_{marker}'\n")).unwrap();
}

fn ok(r: &Path) {
    std::fs::write(r.join("ok.py"), "def visible_marker():\n    return 1\n").unwrap();
}

#[test]
fn baseline_finds_a_normal_file() {
    let s = start("base", |r, _| ok(r));
    assert!(everything(&s, &["visible_marker"]).contains("ok.py"));
}

#[test]
fn file_symlink_to_outside_is_never_served() {
    let s = start("flink", |r, o| {
        plant(o, "out.py", "outside_f");
        std::os::unix::fs::symlink(o.join("out.py"), r.join("link.py")).unwrap();
        ok(r);
    });
    let out = everything(&s, &["outside_f"]);
    assert!(out.contains("ok.py") && !out.contains("PAYLOAD_") && !out.contains("link.py"), "{out}");
}

#[test]
fn dir_symlink_to_outside_is_never_served() {
    let s = start("dlink", |r, o| {
        plant(o, "deep.py", "outside_d");
        std::os::unix::fs::symlink(o, r.join("linked_dir")).unwrap();
        ok(r);
    });
    let out = everything(&s, &["outside_d"]);
    assert!(out.contains("ok.py") && !out.contains("PAYLOAD_") && !out.contains("linked_dir"), "{out}");
}

#[test]
fn symlink_inside_root_is_not_indexed_twice() {
    let s = start("inlink", |r, _| {
        plant(r, "real.py", "inside_marker");
        std::os::unix::fs::symlink(r.join("real.py"), r.join("alias.py")).unwrap();
    });
    let out = call(&s, "find_symbol", r#"{"name":"inside_marker"}"#);
    assert!(out.contains("real.py") && !out.contains("alias.py"), "{out}");
}

#[test]
fn hidden_files_and_dirs_are_never_served() {
    let s = start("hidden", |r, _| {
        plant(r, ".hidden.py", "hidden_a");
        plant(r, ".venv/lib/x.py", "hidden_b");
        plant(r, "src/.cache/y.py", "hidden_c");
        ok(r);
    });
    let out = everything(&s, &["hidden_a", "hidden_b", "hidden_c"]);
    assert!(out.contains("ok.py"), "{out}");
    for bad in ["PAYLOAD_", ".hidden.py", ".venv", ".cache"] {
        assert!(!out.contains(bad), "{bad}: {out}");
    }
}

#[test]
fn gitignored_files_are_never_served() {
    let s = start("ign", |r, _| {
        std::fs::write(r.join(".gitignore"), "ignored.py\nbuild/\n").unwrap();
        plant(r, "ignored.py", "ignored_a");
        plant(r, "build/b.py", "ignored_b");
        ok(r);
    });
    let out = everything(&s, &["ignored_a", "ignored_b"]);
    assert!(out.contains("ok.py"), "{out}");
    for bad in ["PAYLOAD_", "ignored.py", "build/b.py"] {
        assert!(!out.contains(bad), "{bad}: {out}");
    }
}

#[test]
fn traversal_in_arguments_reads_nothing_outside() {
    let s = start("trav", |r, o| {
        plant(o, "secret.py", "trav_marker");
        ok(r);
    });
    let abs = s.base.join("outside/secret.py");
    let abs = abs.to_str().unwrap();
    let mut out = String::new();
    for q in ["../outside/secret.py", "../../etc/passwd", "/etc/passwd", abs, "..%2f..%2fetc%2fpasswd", "trav_marker"] {
        out.push_str(&call(&s, "search_codebase", &format!(r#"{{"query":"{q}"}}"#)));
        out.push_str(&call(&s, "find_symbol", &format!(r#"{{"name":"{q}"}}"#)));
    }
    for extra in [format!(r#"{{"query":"x","path":"{abs}"}}"#), format!(r#"{{"query":"x","root":"{abs}"}}"#), r#"{"query":"x","path":"../../etc/passwd"}"#.into()] {
        out.push_str(&call(&s, "search_codebase", &extra));
    }
    assert!(!out.contains("PAYLOAD_") && !out.contains("root:"), "{out}");
}
