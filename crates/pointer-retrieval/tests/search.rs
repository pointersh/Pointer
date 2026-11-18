use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
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
fn start(tag: &str, files: &[(&str, &str)]) -> Srv {
    let dir = std::env::temp_dir().join(format!("pr-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (p, c) in files {
        let f = dir.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, c).unwrap();
    }
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
        dir,
    }
}

fn post(s: &Srv, body: &str) -> (u16, String) {
    let mut c = TcpStream::connect(("127.0.0.1", s.port)).unwrap();
    c.set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        s.token,
        body.len()
    );
    c.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = c.read_to_string(&mut out);
    let status = out
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    (status, out.replace("\\n", "\n"))
}

fn call(s: &Srv, tool: &str, args: &str) -> String {
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"{tool}","arguments":{args}}}}}"#
    );
    post(s, &body).1
}

fn ranked(out: &str) -> Vec<String> {
    let at = out
        .find("Pointing at:")
        .unwrap_or_else(|| panic!("no listing: {out}"));
    let mut seen: Vec<String> = Vec::new();
    for l in out[at..].lines().skip(1).take_while(|l| !l.is_empty()) {
        let p = l.split(':').next().unwrap().to_string();
        if !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen
}

const AUTH: &str = "class TokenRefresher:\n    def refresh_token(self, user):\n        return rotate_credentials(user)\n";
const TESTS: &str = "from auth import TokenRefresher\n\ndef test_refresh_token():\n    assert TokenRefresher().refresh_token(1)\n";
const NOISE: &str = "def render_page(title):\n    return title.upper()\n";
fn corpus() -> Vec<(&'static str, &'static str)> {
    vec![
        ("src/auth.py", AUTH),
        ("tests/test_auth.py", TESTS),
        ("src/page.py", NOISE),
        ("src/util.py", "def clamp(x):\n    return x\n"),
    ]
}

#[test]
fn defining_file_ranks_first_for_symbol() {
    let s = start("sym", &corpus());
    let out = call(&s, "search_codebase", r#"{"query":"TokenRefresher"}"#);
    assert_eq!(ranked(&out)[0], "src/auth.py", "{out}");
}

#[test]
fn test_file_ranks_below_code() {
    let s = start("tbelow", &corpus());
    let r = ranked(&call(
        &s,
        "search_codebase",
        r#"{"query":"refresh_token TokenRefresher"}"#,
    ));
    let code = r
        .iter()
        .position(|p| p == "src/auth.py")
        .expect("code missing");
    if let Some(t) = r.iter().position(|p| p == "tests/test_auth.py") {
        assert!(code < t, "{r:?}");
    }
}

#[test]
fn test_file_surfaces_when_query_mentions_tests() {
    let s = start("tint", &corpus());
    let r = ranked(&call(
        &s,
        "search_codebase",
        r#"{"query":"tests for refresh_token"}"#,
    ));
    assert_eq!(r[0], "tests/test_auth.py", "{r:?}");
}

#[test]
fn unmatched_query_says_so() {
    let s = start("none", &corpus());
    let out = call(&s, "search_codebase", r#"{"query":"zzqqxx"}"#);
    assert!(out.contains("nothing matched"), "{out}");
}

#[test]
fn repeated_queries_are_identical() {
    let s = start("rep", &corpus());
    let first = ranked(&call(
        &s,
        "search_codebase",
        r#"{"query":"refresh token rotate credentials"}"#,
    ));
    for _ in 0..10 {
        assert_eq!(
            ranked(&call(
                &s,
                "search_codebase",
                r#"{"query":"refresh token rotate credentials"}"#
            )),
            first
        );
    }
}

#[test]
fn concurrent_queries_agree() {
    let s = std::sync::Arc::new(start("conc", &corpus()));
    let want = ranked(&call(
        &s,
        "search_codebase",
        r#"{"query":"refresh token rotate credentials"}"#,
    ));
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let s = s.clone();
            std::thread::spawn(move || {
                ranked(&call(
                    &s,
                    "search_codebase",
                    r#"{"query":"refresh token rotate credentials"}"#,
                ))
            })
        })
        .collect();
    for h in hs {
        assert_eq!(h.join().unwrap(), want);
    }
}

#[test]
fn find_symbol_lists_definition() {
    let s = start("fs", &corpus());
    let out = call(&s, "find_symbol", r#"{"name":"TokenRefresher"}"#);
    assert!(out.contains("src/auth.py:1"), "{out}");
}
