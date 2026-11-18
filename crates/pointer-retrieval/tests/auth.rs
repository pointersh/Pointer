use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};

struct Srv {
    child: Child,
    port: u16,
    token: String,
    dir: std::path::PathBuf,
}

impl Drop for Srv {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start(tag: &str) -> Srv {
    let dir = std::env::temp_dir().join(format!("pr-auth-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.py"), "def hello():\n    return 1\n").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pointer-retrieval"))
        .args(["--root", dir.to_str().unwrap(), "--exit-with-stdin"])
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
    let port: u16 = parts[1]
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
        dir,
    }
}

fn post(port: u16, auth: Option<&str>, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    let mut req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(a) = auth {
        req.push_str(&format!("Authorization: {a}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    let status = out
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    (status, out)
}

const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
const CALL: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_symbol","arguments":{"name":"hello"}}}"#;

#[test]
fn no_token_is_refused() {
    let s = start("none");
    for body in [INIT, CALL] {
        let (status, out) = post(s.port, None, body);
        assert_eq!(status, 401, "{out}");
        assert!(!out.contains("hello"), "{out}");
    }
}

#[test]
fn wrong_token_is_refused() {
    let s = start("wrong");
    let wrong = format!("Bearer {}x", s.token);
    let short = format!("Bearer {}", &s.token[..s.token.len() - 1]);
    let bare = s.token.clone();
    let basic = format!("Basic {}", s.token);
    for auth in [
        wrong,
        short,
        bare,
        basic,
        "Bearer ".into(),
        "Bearer".into(),
        "bearer abc".into(),
    ] {
        let (status, out) = post(s.port, Some(&auth), CALL);
        assert_eq!(status, 401, "auth {auth:?}: {out}");
    }
}

#[test]
fn right_token_is_accepted() {
    let s = start("ok");
    let (status, out) = post(s.port, Some(&format!("Bearer {}", s.token)), INIT);
    assert_eq!(status, 200, "{out}");
    assert!(out.contains("protocolVersion"), "{out}");
}

#[test]
fn token_is_not_guessable_and_fresh() {
    let a = start("t1");
    let b = start("t2");
    assert!(a.token.len() >= 32, "token too short: {}", a.token);
    assert!(a.token.chars().all(|c| c.is_ascii_alphanumeric()));
    assert_ne!(a.token, b.token);
    assert_ne!(a.port, b.port);
}

#[test]
fn binds_loopback_only() {
    let s = start("bind");
    let lo: SocketAddr = ([127, 0, 0, 1], s.port).into();
    assert!(TcpStream::connect_timeout(&lo, std::time::Duration::from_secs(2)).is_ok());
    let out = Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-iTCP",
            "-sTCP:LISTEN",
            "-p",
            &s.child.id().to_string(),
        ])
        .output();
    if let Ok(o) = out {
        let text = String::from_utf8_lossy(&o.stdout);
        if text.contains("LISTEN") {
            assert!(text.contains(&format!("127.0.0.1:{}", s.port)), "{text}");
            assert!(!text.contains("*:") && !text.contains("0.0.0.0"), "{text}");
        }
    }
}

#[test]
fn other_paths_and_methods_need_the_token_too() {
    let s = start("paths");
    for path in ["/", "/mcp/", "/admin", "/mcp/x"] {
        let mut c = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
        c.set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        write!(
            c,
            "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 401"), "{path}: {out}");
    }
}
