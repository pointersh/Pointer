#![allow(dead_code)]
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


fn corpus() -> Vec<(String, String)> {
    let mut v = Vec::new();
    for i in 0..30 {
        let body: String = (0..40)
            .map(|j| format!("    total_{i}_{j} = compute_invoice_total(items, {j})\n"))
            .collect();
        v.push((
            format!("src/billing{i}.py"),
            format!("def compute_invoice_total(items, n):\n{body}"),
        ));
    }
    v
}

fn srv(tag: &str) -> Srv {
    let c = corpus();
    let f: Vec<(&str, &str)> = c.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
    start(tag, &f)
}

fn dropped(out: &str) -> usize {
    let at = out
        .find("dropped ")
        .unwrap_or_else(|| panic!("no dropped line: {out}"));
    out[at + 8..]
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn zero_budget_is_floored_and_reports_the_rest() {
    let s = srv("zero");
    let q = |b: &str| call(&s, "search_codebase", &format!(r#"{{"query":"compute_invoice_total","budget_tokens":{b}}}"#));
    let zero = q("0");
    assert_eq!(ranked(&zero), ranked(&q("500")));
    assert!(dropped(&zero) > 0, "{zero}");
}

#[test]
fn small_budget_selects_fewer_and_reports_the_rest() {
    let s = srv("small");
    let q = |b: &str| {
        call(
            &s,
            "search_codebase",
            &format!(r#"{{"query":"compute_invoice_total","budget_tokens":{b}}}"#),
        )
    };
    let small = q("600");
    let big = q("5000");
    assert!(
        dropped(&small) > dropped(&big),
        "small {} big {}",
        dropped(&small),
        dropped(&big)
    );
    assert!(ranked(&small).len() < ranked(&big).len(), "{small}");
}

#[test]
fn huge_budget_is_capped_not_rejected() {
    let s = srv("huge");
    let huge = call(
        &s,
        "search_codebase",
        r#"{"query":"compute_invoice_total","budget_tokens":18446744073709551615}"#,
    );
    let cap = call(
        &s,
        "search_codebase",
        r#"{"query":"compute_invoice_total","budget_tokens":5000}"#,
    );
    assert_eq!(ranked(&huge), ranked(&cap));
    assert_eq!(dropped(&huge), dropped(&cap));
}

#[test]
fn default_budget_matches_3000() {
    let s = srv("def");
    let a = call(
        &s,
        "search_codebase",
        r#"{"query":"compute_invoice_total"}"#,
    );
    let b = call(
        &s,
        "search_codebase",
        r#"{"query":"compute_invoice_total","budget_tokens":3000}"#,
    );
    assert_eq!(ranked(&a), ranked(&b));
}

#[test]
fn repo_map_handles_zero_and_huge() {
    let s = srv("map");
    for b in ["0", "1", "5000", "18446744073709551615"] {
        let out = call(&s, "repo_map", &format!(r#"{{"budget_tokens":{b}}}"#));
        assert!(!out.contains("isError\":true"), "{b}: {out}");
    }
}
