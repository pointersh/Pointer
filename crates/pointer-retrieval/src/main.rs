mod index;
mod parse;

use index::{FileData, Index};
use rayon::prelude::*;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::schemars::JsonSchema;
use rmcp::transport::streamable_http_server::{session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_router};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

const MAX_FILE_BYTES: u64 = 1_000_000;
const LOCKFILES: &[&str] = &["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "composer.lock", "Gemfile.lock"];

struct Store {
    root: PathBuf,
    files: Mutex<HashMap<String, FileData>>,
    index: RwLock<Arc<Index>>,
}

impl Store {
    fn relative(&self, path: &Path) -> Option<String> {
        path.strip_prefix(&self.root).ok().map(|p| p.to_string_lossy().replace('\\', "/"))
    }

    fn read(&self, path: &Path) -> Option<(String, FileData)> {
        let rel = self.relative(path)?;
        let name = path.file_name()?.to_string_lossy();
        if LOCKFILES.contains(&name.as_ref()) || rel.split('/').any(|p| p == ".git") {
            return None;
        }
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        if bytes.iter().take(8192).any(|&b| b == 0) {
            return None;
        }
        let src = String::from_utf8(bytes).ok()?;
        let hash = xxhash_rust::xxh3::xxh3_64(src.as_bytes());
        let parsed = parse::parse(&rel, &src);
        Some((rel, FileData { hash, parsed }))
    }

    fn index_all(&self) {
        let paths: Vec<PathBuf> = ignore::WalkBuilder::new(&self.root)
            .hidden(true)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map(|e| e.into_path())
            .collect();
        let files: HashMap<String, FileData> = paths.par_iter().filter_map(|p| self.read(p)).collect();
        *self.files.lock().unwrap() = files;
        self.rebuild();
    }

    fn update(&self, changed: &[PathBuf], ignored: &ignore::gitignore::Gitignore) {
        let mut dirty = false;
        {
            let mut files = self.files.lock().unwrap();
            for path in changed {
                let Some(rel) = self.relative(path) else { continue };
                if ignored.matched_path_or_any_parents(path, path.is_dir()).is_ignore() {
                    continue;
                }
                match self.read(path) {
                    Some((rel, data)) => {
                        if files.get(&rel).map(|f| f.hash) != Some(data.hash) {
                            files.insert(rel, data);
                            dirty = true;
                        }
                    }
                    None => dirty |= files.remove(&rel).is_some(),
                }
            }
        }
        if dirty {
            self.rebuild();
        }
    }

    fn rebuild(&self) {
        let index = Index::build(&self.files.lock().unwrap());
        *self.index.write().unwrap() = Arc::new(index);
    }

    fn current(&self) -> Arc<Index> {
        self.index.read().unwrap().clone()
    }
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
struct MapArgs {
    budget_tokens: Option<usize>,
}

#[derive(Clone)]
struct Retrieval {
    store: Arc<Store>,
}

#[tool_router(server_handler)]
impl Retrieval {
    #[tool(
        description = "Find the code most relevant to a question or task, packed within a token budget. Lists the chosen chunks with a computed reason for each, then their contents.",
        annotations(read_only_hint = true)
    )]
    fn search_codebase(&self, Parameters(args): Parameters<SearchArgs>) -> String {
        let started = Instant::now();
        let out = self.store.current().search_text(&args.query, args.budget_tokens.unwrap_or(4500).min(5000), &[]);
        eprintln!("pointer-retrieval: search {:?} in {:?}", args.query, started.elapsed());
        out
    }

    #[tool(description = "Where a symbol is defined and where it is referenced (path:line).", annotations(read_only_hint = true))]
    fn find_symbol(&self, Parameters(args): Parameters<SymbolArgs>) -> String {
        self.store.current().find_symbol(&args.name)
    }

    #[tool(
        description = "A map of the most important files and their key definitions, ranked by PageRank over references, fitted to a token budget.",
        annotations(read_only_hint = true)
    )]
    fn repo_map(&self, Parameters(args): Parameters<MapArgs>) -> String {
        self.store.current().repo_map(args.budget_tokens.unwrap_or(2000))
    }
}

fn watch(store: Arc<Store>) -> notify::Result<notify::RecommendedWatcher> {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })?;
    watcher.watch(&store.root, notify::RecursiveMode::Recursive)?;
    let (ignored, _) = ignore::gitignore::Gitignore::new(store.root.join(".gitignore"));
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(path) = rx.recv_timeout(Duration::from_millis(300)) {
                batch.push(path);
            }
            batch.sort();
            batch.dedup();
            let started = Instant::now();
            store.update(&batch, &ignored);
            eprintln!("pointer-retrieval: reindexed {} paths in {:?}", batch.len(), started.elapsed());
        }
    });
    Ok(watcher)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(arg(&args, "--root").ok_or_else(|| anyhow::anyhow!("usage: pointer-retrieval --root <dir> [--port 0]"))?);
    let root = root.canonicalize()?;
    let port: u16 = arg(&args, "--port").map(|p| p.parse()).transpose()?.unwrap_or(0);

    let store = Arc::new(Store {
        root,
        files: Mutex::new(HashMap::new()),
        index: RwLock::new(Arc::new(Index::build(&HashMap::new()))),
    });
    let started = Instant::now();
    store.index_all();
    let index = store.current();
    eprintln!("pointer-retrieval: indexed {} files, {} chunks in {:?}", index.files, index.chunks.len(), started.elapsed());
    let _watcher = watch(store.clone())?;

    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = false;
    config.json_response = true;
    let service_store = store.clone();
    let service = StreamableHttpService::new(
        move || Ok(Retrieval { store: service_store.clone() }),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let expected = format!("Bearer {token}");
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
            let ok = req.headers().get("authorization").and_then(|v| v.to_str().ok()) == Some(expected.as_str());
            async move {
                if ok {
                    next.run(req).await
                } else {
                    axum::http::StatusCode::UNAUTHORIZED.into_response()
                }
            }
        }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    println!("READY http://127.0.0.1:{}/mcp {token}", addr.port());
    axum::serve(listener, app).await?;
    Ok(())
}

use axum::response::IntoResponse;
