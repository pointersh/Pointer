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
    std::fs::write(
        p,
        format!("def {marker}():\n    return 'PAYLOAD_{}'\n", marker.to_uppercase()),
    )
    .unwrap();
}

fn leaks(name: &str, marker: &str) -> String {
    let s = start("sec", |r, _| {
        plant(r, name, marker);
        std::fs::write(r.join("ok.py"), "def visible_marker():\n    return 1\n").unwrap();
    });
    let out = everything(&s, &[marker]);
    assert!(out.contains("ok.py"), "baseline missing: {out}");
    out
}

fn assert_hidden(name: &str, marker: &str) {
    let out = leaks(name, marker);
    assert!(
        !out.contains("PAYLOAD_") && !out.contains(name),
        "{name} leaked: {out}"
    );
}

#[test]
fn dotenv_is_hidden() {
    assert_hidden(".env", "env_marker");
    assert_hidden(".env.production", "envprod_marker");
}

#[test]
fn npmrc_is_hidden() {
    assert_hidden(".npmrc", "npmrc_marker");
}

#[test]
fn nested_dot_secrets_are_hidden() {
    assert_hidden("config/.env", "nested_env_marker");
    assert_hidden(".ssh/id_rsa", "ssh_dir_marker");
}

#[test]
fn pem_files_are_hidden() {
    assert_hidden("cert.pem", "pem_marker");
    assert_hidden("keys/server.pem", "pem_nested_marker");
}

#[test]
fn private_key_files_are_hidden() {
    assert_hidden("id_rsa", "idrsa_marker");
    assert_hidden("id_ed25519", "ided_marker");
    assert_hidden("server.key", "key_marker");
}

#[test]
fn env_suffix_files_are_hidden() {
    assert_hidden("prod.env", "prodenv_marker");
}

#[test]
fn credential_files_are_hidden() {
    assert_hidden("credentials.json", "creds_marker");
    assert_hidden("terraform.tfstate", "tfstate_marker");
}

#[test]
fn secret_symlinked_from_root_is_hidden() {
    let s = start("secln", |r, o| {
        plant(o, ".env", "linked_env_marker");
        std::os::unix::fs::symlink(o.join(".env"), r.join("config.py")).unwrap();
        std::fs::write(r.join("ok.py"), "def visible_marker():\n    return 1\n").unwrap();
    });
    let out = everything(&s, &["linked_env_marker"]);
    assert!(
        !out.contains("PAYLOAD_"),
        "{out}"
    );
}

#[test]
fn secrets_never_appear_even_when_queried_by_name() {
    let s = start("byname", |r, _| {
        plant(r, ".env", "env_marker");
        plant(r, "id_rsa", "idrsa_marker");
        std::fs::write(r.join("ok.py"), "def visible_marker():\n    return 1\n").unwrap();
    });
    let mut out = String::new();
    for q in [".env", "id_rsa", "env_marker", "idrsa_marker"] {
        out.push_str(&call(
            &s,
            "search_codebase",
            &format!(r#"{{"query":"{q}"}}"#),
        ));
    }
    assert!(
        !out.contains("PAYLOAD_"),
        "{out}"
    );
}
