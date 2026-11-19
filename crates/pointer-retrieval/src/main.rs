mod index;
mod parse;
#[cfg(feature = "semantic")]
mod semantic;

use index::{FileData, Index};
use rayon::prelude::*;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::schemars::JsonSchema;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_router};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_FILES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 200_000_000;
// Dependency and build output: never useful context, and the usual cause of a runaway index.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "venv",
    "__pycache__",
    "target",
    "dist",
    "build",
    "vendor",
];
// Secret-bearing names that are not dotfiles; .env, .npmrc and friends are already hidden.
const SECRET_EXTS: &[&str] = &["pem", "key", "p12", "pfx", "tfstate", "env", "crt", "jks"];
const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "go.sum",
    "composer.lock",
    "Gemfile.lock",
];

struct Store {
    root: PathBuf,
    files: Mutex<HashMap<String, FileData>>,
    index: RwLock<Arc<Index>>,
}

impl Store {
    fn relative(&self, path: &Path) -> Option<String> {
        path.strip_prefix(&self.root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
    }

    // The one filter for both the startup walk and the watcher: no hidden paths (.env, .git, .venv),
    // no symlinks, nothing whose real path leaves the root.
    fn read(&self, path: &Path) -> Option<(String, FileData)> {
        let rel = self.relative(path)?;
        let name = path.file_name()?.to_string_lossy();
        if LOCKFILES.contains(&name.as_ref())
            || is_secret(&name)
            || name.ends_with(".min.js")
            || name.ends_with(".map")
            || rel
                .split('/')
                .any(|p| p.starts_with('.') || SKIP_DIRS.contains(&p))
        {
            return None;
        }
        let meta = std::fs::symlink_metadata(path).ok()?;
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return None;
        }
        if !path.canonicalize().ok()?.starts_with(&self.root) {
            return None;
        }
        // ponytail: a swap to a symlink between the checks above and this open is not caught (needs
        // O_NOFOLLOW via libc); the read itself is capped so a grown file cannot blow the limit.
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_FILE_BYTES || bytes.iter().take(8192).any(|&b| b == 0) {
            return None;
        }
        let src = String::from_utf8(bytes).ok()?;
        let hash = xxhash_rust::xxh3::xxh3_64(src.as_bytes());
        let parsed = match std::panic::catch_unwind(|| parse::parse(&rel, &src)) {
            Ok(parsed) => parsed,
            Err(_) => {
                eprintln!("pointer-retrieval: skipped {rel}: the parser failed on it");
                return None;
            }
        };
        Some((rel, FileData { hash, parsed }))
    }

    fn index_all(&self) {
        // Bounded walk: skip dependency dirs outright, stop at the file and byte caps.
        let mut total = 0u64;
        let paths: Vec<PathBuf> = ignore::WalkBuilder::new(&self.root)
            .hidden(true)
            .require_git(false)
            .filter_entry(|e| !SKIP_DIRS.iter().any(|d| e.file_name() == *d))
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map_while(|e| {
                total += e.metadata().map_or(0, |m| m.len());
                (total <= MAX_TOTAL_BYTES).then(|| e.into_path())
            })
            .take(MAX_FILES)
            .collect();
        if paths.len() >= MAX_FILES || total > MAX_TOTAL_BYTES {
            eprintln!(
                "pointer-retrieval: index capped at {} files, {} MB",
                paths.len(),
                MAX_TOTAL_BYTES / 1_000_000
            );
        }
        let files: HashMap<String, FileData> =
            paths.par_iter().filter_map(|p| self.read(p)).collect();
        *self.files.lock().unwrap() = files;
        self.rebuild();
    }

    // Ignore files from the path's directory up to the root, plus .git/info/exclude, read fresh each time.
    // The closest file with an opinion wins, so a nested `!keep.log` beats a parent's `*.log`.
    // ponytail: the global gitignore (core.excludesFile) and ignore files above the root are not
    // read here, unlike the startup walk; upgrade by building the matcher once from WalkBuilder's rules.
    fn ignored(&self, path: &Path) -> bool {
        let is_dir = path.is_dir();
        for dir in path
            .ancestors()
            .skip(1)
            .take_while(|dir| dir.starts_with(&self.root))
        {
            for name in [".ignore", ".rgignore", ".gitignore"] {
                let (rules, _) = ignore::gitignore::Gitignore::new(dir.join(name));
                let m = rules.matched_path_or_any_parents(path, is_dir);
                if !m.is_none() {
                    return m.is_ignore();
                }
            }
        }
        let (exclude, _) = ignore::gitignore::Gitignore::new(self.root.join(".git/info/exclude"));
        exclude
            .matched_path_or_any_parents(path, is_dir)
            .is_ignore()
    }

    fn update(&self, changed: &[PathBuf]) {
        // An edited ignore file can hide or admit any file: re-walk everything under the current rules.
        if changed.iter().any(|p| {
            matches!(
                p.file_name().and_then(|n| n.to_str()),
                Some(".gitignore" | ".ignore" | ".rgignore" | "exclude")
            )
        }) {
            return self.index_all();
        }
        let mut files = self.files.lock().unwrap();
        let before = files.len();
        let mut dirty = false;
        for path in changed {
            let Some(rel) = self.relative(path) else {
                continue;
            };
            // Hidden paths (.git, .venv) are never indexed: skip before any ignore read or walk.
            if rel.split('/').any(|p| p.starts_with('.')) {
                continue;
            }
            let prefix = format!("{rel}/");
            // A deleted, renamed or newly ignored directory takes every file under it along.
            let drop_under = |files: &mut HashMap<String, FileData>| {
                files.retain(|k, _| k != &rel && !k.starts_with(&prefix));
            };
            if self.ignored(path) {
                drop_under(&mut files);
                continue;
            }
            if path.is_dir() && !path.is_symlink() {
                for entry in ignore::WalkBuilder::new(path)
                    .hidden(true)
                    .require_git(false)
                    .build()
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
                {
                    if self.ignored(entry.path()) {
                        continue;
                    }
                    if let Some((rel, data)) = self.read(entry.path()) {
                        dirty |= files.get(&rel).map(|f| f.hash) != Some(data.hash);
                        files.insert(rel, data);
                    }
                }
                continue;
            }
            match self.read(path) {
                Some((rel, data)) => {
                    if files.get(&rel).map(|f| f.hash) != Some(data.hash) {
                        files.insert(rel, data);
                        dirty = true;
                    }
                }
                None => drop_under(&mut files),
            }
        }
        if dirty || files.len() != before {
            self.rebuild_locked(&files);
        }
    }

    fn rebuild(&self) {
        let files = self.files.lock().unwrap();
        self.rebuild_locked(&files);
    }

    // Built and published under the files lock, so an older build can never overwrite a newer one.
    fn rebuild_locked(&self, files: &HashMap<String, FileData>) {
        let index = Index::build(files);
        *self.index.write().unwrap() = Arc::new(index);
    }

    fn current(&self) -> Arc<Index> {
        self.index.read().unwrap().clone()
    }
}

fn is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let ext = n.rsplit_once('.').map_or("", |(_, e)| e);
    SECRET_EXTS.contains(&ext)
        || n.starts_with("id_rsa")
        || n.starts_with("id_ed25519")
        || n.starts_with("id_ecdsa")
        || n.starts_with("id_dsa")
        || ((n.contains("credential") || n.contains("secret"))
            && matches!(
                ext,
                "" | "json" | "yml" | "yaml" | "toml" | "ini" | "txt" | "cfg"
            ))
}

#[derive(Deserialize, JsonSchema)]
struct SearchArgs {
    query: String,
    budget_tokens: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct SymbolArgs {
    name: String,
}

#[derive(Deserialize, JsonSchema)]
struct SyntaxArgs {
    path: String,
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct MapArgs {
    budget_tokens: Option<usize>,
}

#[derive(Clone)]
struct Retrieval {
    store: Arc<Store>,
    #[cfg(feature = "semantic")]
    semantic: Option<Arc<semantic::Semantic>>,
}

impl Retrieval {
    #[cfg(feature = "semantic")]
    fn semantic_signal(&self, index: &Index, query: &str) -> Vec<(usize, f32, String)> {
        self.semantic
            .as_ref()
            .map(|s| s.rank(index, query))
            .unwrap_or_default()
    }

    #[cfg(not(feature = "semantic"))]
    fn semantic_signal(&self, _: &Index, _: &str) -> Vec<(usize, f32, String)> {
        Vec::new()
    }

    #[cfg(feature = "semantic")]
    fn semantic_status(&self) -> String {
        self.semantic.as_ref().map_or_else(
            || "semantic: off".into(),
            |s| format!("{}; vectors {} KB", s.status(), s.memory_bytes() / 1024),
        )
    }

    #[cfg(not(feature = "semantic"))]
    fn semantic_status(&self) -> String {
        "semantic: off (built without the semantic feature)".into()
    }
}

#[tool_router(server_handler)]
impl Retrieval {
    #[tool(
        description = "Find the code most relevant to a question or task, packed within a token budget. Lists the chosen chunks with a computed reason for each, then their contents.",
        annotations(read_only_hint = true)
    )]
    fn search_codebase(&self, Parameters(args): Parameters<SearchArgs>) -> String {
        let started = Instant::now();
        let index = self.store.current();
        let semantic = index::Precomputed(self.semantic_signal(&index, &args.query));
        let extra: Vec<&dyn index::Signal> = if semantic.0.is_empty() {
            Vec::new()
        } else {
            vec![&semantic]
        };
        let out = index.search_text(
            &args.query,
            args.budget_tokens.unwrap_or(3000).clamp(500, 5000),
            &extra,
        );
        eprintln!(
            "pointer-retrieval: search {:?} ({} chars) in {:?}",
            args.query.chars().take(120).collect::<String>(),
            args.query.chars().count(),
            started.elapsed()
        );
        out
    }

    #[tool(
        description = "Where a symbol is defined and where it is referenced (path:line).",
        annotations(read_only_hint = true)
    )]
    fn find_symbol(&self, Parameters(args): Parameters<SymbolArgs>) -> String {
        self.store.current().find_symbol(&args.name)
    }

    #[tool(
        description = "Check whether a file's full text parses (tree-sitter: Python, JS, TS, Rust, Go). Answers ok, error at line N, or unsupported.",
        annotations(read_only_hint = true)
    )]
    fn check_syntax(&self, Parameters(args): Parameters<SyntaxArgs>) -> String {
        match parse::syntax_error(&args.path, &args.text) {
            None => "unsupported".into(),
            Some(None) => "ok".into(),
            Some(Some(line)) => format!("error at line {line}"),
        }
    }

    #[tool(
        description = "A map of the most important files and their key definitions, ranked by PageRank over references, fitted to a token budget.",
        annotations(read_only_hint = true)
    )]
    fn repo_map(&self, Parameters(args): Parameters<MapArgs>) -> String {
        self.store
            .current()
            .repo_map(args.budget_tokens.unwrap_or(2000).clamp(500, 5000))
    }

    #[tool(
        description = "Indexing state: chunk count and whether semantic search is off, building (with progress) or ready.",
        annotations(read_only_hint = true)
    )]
    fn index_status(&self) -> String {
        let index = self.store.current();
        format!(
            "{}\nchunks: {} in {} files",
            self.semantic_status(),
            index.chunks.len(),
            index.files
        )
    }
}

fn watch(
    store: Arc<Store>,
    after: impl Fn() + Send + 'static,
) -> notify::Result<notify::RecommendedWatcher> {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event
                .paths
                .into_iter()
                .filter(|p| !p.components().any(|c| c.as_os_str() == ".pointer"))
            {
                let _ = tx.send(path);
            }
        }
    })?;
    watcher.watch(&store.root, notify::RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            // Wait for 300 ms of quiet, but never more than 2 s, so a long build's writes can't starve reindexing.
            let opened = Instant::now();
            while opened.elapsed() < Duration::from_secs(2) {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(path) => batch.push(path),
                    Err(_) => break,
                }
            }
            batch.sort();
            batch.dedup();
            let started = Instant::now();
            store.update(&batch);
            after();
            eprintln!(
                "pointer-retrieval: reindexed {} paths in {:?}",
                batch.len(),
                started.elapsed()
            );
        }
    });
    Ok(watcher)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(arg(&args, "--root").ok_or_else(|| {
        anyhow::anyhow!("usage: pointer-retrieval --root <dir> [--port 0] [--semantic]")
    })?);
    let root = root.canonicalize()?;
    let port: u16 = arg(&args, "--port")
        .map(|p| p.parse())
        .transpose()?
        .unwrap_or(0);
    // Launched by the extension with a pipe on stdin: when the extension host dies, the pipe closes and so do we.
    if args.iter().any(|a| a == "--exit-with-stdin") {
        std::thread::spawn(|| {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            std::process::exit(0);
        });
    }

    let store = Arc::new(Store {
        root,
        files: Mutex::new(HashMap::new()),
        index: RwLock::new(Arc::new(Index::build(&HashMap::new()))),
    });
    let started = Instant::now();
    store.index_all();
    let index = store.current();
    eprintln!(
        "pointer-retrieval: indexed {} files, {} chunks in {:?}",
        index.files,
        index.chunks.len(),
        started.elapsed()
    );
    // .pointer must be a real directory (or absent): a symlink planted by the repo would redirect our writes.
    let dot_ok =
        std::fs::symlink_metadata(store.root.join(".pointer")).map_or(true, |m| m.is_dir());
    if !dot_ok {
        eprintln!("pointer-retrieval: .pointer is not a plain directory; semantic search is off");
    }
    #[cfg(feature = "semantic")]
    let semantic = (dot_ok && args.iter().any(|a| a == "--semantic")).then(|| {
        let source = store.clone();
        semantic::Semantic::start(&store.root, move || source.current())
    });
    #[cfg(not(feature = "semantic"))]
    if args.iter().any(|a| a == "--semantic") {
        eprintln!("pointer-retrieval: built without the semantic feature; --semantic ignored");
    }
    #[cfg(feature = "semantic")]
    let notify = semantic.clone();
    let _watcher = watch(store.clone(), move || {
        #[cfg(feature = "semantic")]
        if let Some(s) = &notify {
            s.changed();
        }
    })?;

    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = false;
    config.json_response = true;
    let service_store = store.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(Retrieval {
                store: service_store.clone(),
                #[cfg(feature = "semantic")]
                semantic: semantic.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let expected = format!("Bearer {token}");
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                let ok = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    == Some(expected.as_str());
                async move {
                    if ok {
                        next.run(req).await
                    } else {
                        axum::http::StatusCode::UNAUTHORIZED.into_response()
                    }
                }
            },
        ));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    println!("READY http://127.0.0.1:{}/mcp {token}", addr.port());
    axum::serve(listener, app).await?;
    Ok(())
}

use axum::response::IntoResponse;

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> Store {
        let root = std::env::temp_dir().join(format!("pr-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        Store {
            root,
            files: Mutex::new(HashMap::new()),
            index: RwLock::new(Arc::new(Index::build(&HashMap::new()))),
        }
    }

    #[test]
    fn gitignore_edit_evicts_and_secrets_are_refused() {
        let s = store("ign");
        let w = |n: &str, c: &str| std::fs::write(s.root.join(n), c).unwrap();
        w("a.py", "def a():\n    pass\n");
        w("notes.txt", "hello");
        w("id_rsa", "key");
        w("prod.env", "K=1");
        std::fs::create_dir(s.root.join("sub")).unwrap();
        w("sub/b.txt", "bee");
        w(".ignore", "sub/\n");
        s.index_all();
        {
            let f = s.files.lock().unwrap();
            assert!(f.contains_key("notes.txt") && f.contains_key("a.py"));
            assert!(!f.contains_key("id_rsa") && !f.contains_key("prod.env"));
            assert!(!f.contains_key("sub/b.txt"));
        }
        // the watcher agrees with the walk about .ignore
        s.update(&[s.root.join("sub/b.txt")]);
        assert!(!s.files.lock().unwrap().contains_key("sub/b.txt"));
        w(".gitignore", "notes.txt\n");
        s.update(&[s.root.join(".gitignore")]);
        assert!(!s.files.lock().unwrap().contains_key("notes.txt"));
        let _ = std::fs::remove_dir_all(&s.root);
    }

    #[test]
    fn file_cap_stops_indexing() {
        let s = store("cap");
        for i in 0..MAX_FILES + 5 {
            std::fs::write(s.root.join(format!("f{i}.txt")), "x").unwrap();
        }
        s.index_all();
        assert_eq!(s.files.lock().unwrap().len(), MAX_FILES);
        let _ = std::fs::remove_dir_all(&s.root);
    }
}
