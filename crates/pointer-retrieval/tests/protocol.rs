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

const AUTH: &str = "class TokenRefresher:\n    def refresh_token(self, user):\n        return rotate_credentials(user)\n";
const NOISE: &str = "def render_page(title):\n    return title.upper()\n";

fn corpus() -> Vec<(&'static str, &'static str)> {
    vec![("src/auth.py", AUTH), ("src/page.py", NOISE)]
}

fn alive(s: &Srv) {
    let out = call(s, "search_codebase", r#"{"query":"TokenRefresher"}"#);
    assert!(out.contains("src/auth.py"), "server not healthy: {out}");
}

#[test]
fn malformed_json_is_an_error_not_a_crash() {
    let s = start("bad", &corpus());
    for body in [
        "",
        "{",
        "not json",
        "[]",
        r#"{"jsonrpc":"2.0"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":42}"#,
        r#"{"jsonrpc":"1.0","id":1,"method":"tools/list"}"#,
    ] {
        let (status, out) = post(&s, body);
        assert!(
            status >= 400 || out.contains("error"),
            "body {body:?} -> {status} {out}"
        );
        assert!(s.child.id() > 0);
    }
    alive(&s);
}

#[test]
fn unknown_tool_returns_error() {
    let s = start("unk", &corpus());
    let out = call(&s, "no_such_tool", "{}");
    assert!(out.contains("error") || out.contains("isError"), "{out}");
    assert!(!out.contains("Pointing at"), "{out}");
    alive(&s);
}

#[test]
fn unknown_method_returns_error() {
    let s = start("meth", &corpus());
    let (_, out) = post(
        &s,
        r#"{"jsonrpc":"2.0","id":3,"method":"nope/nothing","params":{}}"#,
    );
    assert!(out.contains("error"), "{out}");
    alive(&s);
}

#[test]
fn missing_and_wrong_arguments_return_errors() {
    let s = start("args", &corpus());
    for (tool, args) in [
        ("search_codebase", "{}"),
        ("search_codebase", r#"{"query":5}"#),
        ("search_codebase", r#"{"query":"x","budget_tokens":"lots"}"#),
        ("search_codebase", r#"{"query":"x","budget_tokens":-1}"#),
        ("find_symbol", "{}"),
        ("find_symbol", "null"),
    ] {
        let out = call(&s, tool, args);
        assert!(
            out.contains("error") || out.contains("isError"),
            "{tool} {args}: {out}"
        );
        assert!(!out.contains("Pointing at"), "{tool} {args}: {out}");
    }
    alive(&s);
}

#[test]
fn tools_list_names_every_tool() {
    let s = start("list", &corpus());
    let (_, out) = post(&s, r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#);
    for t in ["search_codebase", "find_symbol", "repo_map", "index_status"] {
        assert!(out.contains(t), "{t} missing: {out}");
    }
}

#[test]
fn empty_workspace_is_handled() {
    let s = start("empty", &[("README.md", "")]);
    let out = call(&s, "search_codebase", r#"{"query":"anything"}"#);
    assert!(out.contains("nothing matched"), "{out}");
    let out = call(&s, "index_status", "{}");
    assert!(out.contains("chunks"), "{out}");
}

#[test]
fn exits_when_stdin_closes() {
    let mut s = start("eof", &corpus());
    drop(s.child.stdin.take());
    let t = std::time::Instant::now();
    loop {
        if s.child.try_wait().unwrap().is_some() {
            return;
        }
        assert!(
            t.elapsed().as_secs() < 5,
            "still running after stdin closed"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
