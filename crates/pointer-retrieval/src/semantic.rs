use crate::index::Index;
use fastembed::{AutoDevicePolicy, EmbeddingModel, TextEmbedding, TextInitOptions};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime};

const MAGIC: &[u8; 8] = b"PTRVEC02";
const MIN_CHARS: usize = 80;
const RECENT: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
const POOL: usize = 100;
const QUERY_CACHE: usize = 256;
const BATCH: usize = 4;
const MAX_LENGTH: usize = 192;
const PASSAGE_CHARS: usize = 750;
const LONG_QUERY: usize = 20;
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";
const MODEL_ID: &str = "bge-small-en-v1.5 192 750";

struct Vector {
    scale: f32,
    values: Vec<i8>,
}

pub struct Semantic {
    file: PathBuf,
    fingerprint: u64,
    model: std::sync::OnceLock<Mutex<TextEmbedding>>,
    vectors: RwLock<HashMap<u64, Vector>>,
    queries: Mutex<HashMap<String, Arc<Vector>>>,
    done: AtomicUsize,
    total: AtomicUsize,
    failed: AtomicBool,
    wake: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

fn quantize(v: &[f32]) -> Vector {
    let max = v.iter().fold(0f32, |m, x| m.max(x.abs())).max(1e-12);
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    Vector {
        scale: max / norm / 127.0,
        values: v.iter().map(|x| (x / max * 127.0).round() as i8).collect(),
    }
}

fn dot(a: &[i8], b: &[i8]) -> i32 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| x as i16 as i32 * y as i16 as i32)
        .sum()
}

fn cosine(q: &Vector, v: &Vector) -> f32 {
    dot(&q.values, &v.values) as f32 * q.scale * v.scale
}

fn cache_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".cache/pointer/fastembed")
}

impl Semantic {
    pub fn start(root: &Path, index: impl Fn() -> Arc<Index> + Send + 'static) -> Arc<Semantic> {
        let file = root.join(".pointer/index/vectors.bin");
        let fingerprint = xxhash_rust::xxh3::xxh3_64(MODEL_ID.as_bytes());
        let semantic = Arc::new(Semantic {
            vectors: RwLock::new(load(&file, fingerprint).unwrap_or_default()),
            file,
            fingerprint,
            model: std::sync::OnceLock::new(),
            queries: Mutex::new(HashMap::new()),
            done: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
            wake: Mutex::new(None),
        });
        let (tx, rx) = std::sync::mpsc::channel();
        *semantic.wake.lock().unwrap() = Some(tx);
        let worker = semantic.clone();
        let root = root.to_path_buf();
        std::thread::spawn(move || {
            let started = Instant::now();
            let options = TextInitOptions::new(EmbeddingModel::BGESmallENV15)
                .with_cache_dir(cache_dir())
                .with_max_length(MAX_LENGTH)
                .with_show_download_progress(false)
                .with_auto_device(AutoDevicePolicy::PreferCPU);
            match TextEmbedding::try_new(options) {
                Ok(model) => {
                    let _ = worker.model.set(Mutex::new(model));
                }
                Err(error) => {
                    eprintln!(
                        "pointer-retrieval: semantic disabled, model failed to load: {error}"
                    );
                    worker.failed.store(true, Ordering::Relaxed);
                    return;
                }
            }
            eprintln!(
                "pointer-retrieval: semantic model loaded in {:?}",
                started.elapsed()
            );
            loop {
                worker.embed_missing(&root, &index());
                if rx.recv().is_err() {
                    return;
                }
                while rx.try_recv().is_ok() {}
            }
        });
        semantic
    }

    pub fn changed(&self) {
        if let Some(tx) = self.wake.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    fn embed_missing(&self, root: &Path, index: &Index) {
        let started = Instant::now();
        let wanted: Vec<usize> = {
            let mut seen = std::collections::HashSet::new();
            index
                .chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| embeddable(c) && seen.insert(c.hash))
                .map(|(i, _)| i)
                .collect()
        };
        let mut missing: Vec<usize> = {
            let have = self.vectors.read().unwrap();
            wanted
                .iter()
                .copied()
                .filter(|&i| !have.contains_key(&index.chunks[i].hash))
                .collect()
        };
        self.total.store(wanted.len(), Ordering::Relaxed);
        self.done
            .store(wanted.len() - missing.len(), Ordering::Relaxed);
        if missing.is_empty() {
            return;
        }
        let mut mtimes: HashMap<&str, SystemTime> = HashMap::new();
        for &i in &missing {
            let path = index.chunks[i].path.as_str();
            mtimes.entry(path).or_insert_with(|| {
                std::fs::metadata(root.join(path))
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH)
            });
        }
        let now = SystemTime::now();
        let bucket = |i: usize| {
            let path = index.chunks[i].path.as_str();
            let old = now
                .duration_since(mtimes[path])
                .is_ok_and(|age| age > RECENT);
            (old, is_test(path))
        };
        missing.sort_by_key(|&i| (bucket(i), index.chunks[i].text.len().min(PASSAGE_CHARS), i));
        let count = missing.len();
        let Some(model) = self.model.get() else {
            return;
        };
        for (n, batch) in missing.chunks(BATCH).enumerate() {
            let texts: Vec<String> = batch.iter().map(|&i| passage(index, i)).collect();
            let embedded = match model.lock().unwrap().embed(&texts, None) {
                Ok(vectors) => vectors,
                Err(error) => {
                    eprintln!("pointer-retrieval: embedding batch failed: {error}");
                    continue;
                }
            };
            let mut have = self.vectors.write().unwrap();
            for (&i, v) in batch.iter().zip(embedded) {
                have.insert(index.chunks[i].hash, quantize(&v));
            }
            drop(have);
            self.done.fetch_add(batch.len(), Ordering::Relaxed);
            if n % 100 == 99 {
                self.save();
            }
        }
        self.save();
        eprintln!(
            "pointer-retrieval: embedded {count} chunks in {:?}",
            started.elapsed()
        );
    }

    fn save(&self) {
        let have = self.vectors.read().unwrap();
        let mut bytes = Vec::with_capacity(have.len() * 780 + 24);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&self.fingerprint.to_le_bytes());
        bytes.extend_from_slice(
            &(have.values().next().map_or(0, |v| v.values.len()) as u32).to_le_bytes(),
        );
        for (hash, v) in have.iter() {
            bytes.extend_from_slice(&hash.to_le_bytes());
            bytes.extend_from_slice(&v.scale.to_le_bytes());
            bytes.extend(v.values.iter().map(|&x| x as u8));
        }
        drop(have);
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(self.file.parent().unwrap())?;
            if let Some(dot) = self.file.ancestors().find(|p| p.ends_with(".pointer")) {
                let ignore = dot.join(".gitignore");
                if !ignore.exists() {
                    std::fs::write(ignore, "*\n")?;
                }
            }
            let tmp = self.file.with_extension("tmp");
            std::fs::File::create(&tmp)?.write_all(&bytes)?;
            std::fs::rename(tmp, &self.file)
        };
        if let Err(error) = write() {
            eprintln!("pointer-retrieval: could not save vectors: {error}");
        }
    }

    pub fn status(&self) -> String {
        if self.failed.load(Ordering::Relaxed) {
            return "semantic: off (model failed to load)".into();
        }
        let (done, total) = (
            self.done.load(Ordering::Relaxed),
            self.total.load(Ordering::Relaxed),
        );
        if total == 0 {
            "semantic: building 0% (loading model)".into()
        } else if done >= total {
            "semantic: ready".into()
        } else {
            format!(
                "semantic: building {}% ({done}/{total})",
                done * 100 / total
            )
        }
    }

    pub fn memory_bytes(&self) -> usize {
        self.vectors
            .read()
            .unwrap()
            .values()
            .map(|v| v.values.len() + 12)
            .sum()
    }

    fn embed_query(&self, query: &str) -> Option<Arc<Vector>> {
        if let Some(v) = self.queries.lock().unwrap().get(query) {
            return Some(v.clone());
        }
        let text = format!("{QUERY_PREFIX}{query}");
        let mut model = self.model.get()?.try_lock().ok()?;
        let embedded = model.embed([text], None).ok()?;
        drop(model);
        let v = Arc::new(quantize(embedded.first()?));
        let mut cache = self.queries.lock().unwrap();
        if cache.len() >= QUERY_CACHE {
            cache.clear();
        }
        cache.insert(query.to_string(), v.clone());
        Some(v)
    }

    pub fn rank(&self, index: &Index, query: &str) -> Vec<(usize, f32, String)> {
        if self.vectors.read().unwrap().is_empty()
            || crate::index::tokenize(query).len() > LONG_QUERY
        {
            return Vec::new();
        }
        let Some(q) = self.embed_query(query) else {
            return Vec::new();
        };
        let have = self.vectors.read().unwrap();
        let mut scored: Vec<(usize, f32)> = index
            .chunks
            .iter()
            .enumerate()
            .filter_map(|(i, c)| have.get(&c.hash).map(|v| (i, cosine(&q, v))))
            .collect();
        drop(have);
        if scored.len() > POOL {
            scored.select_nth_unstable_by(POOL, |a, b| b.1.total_cmp(&a.1));
            scored.truncate(POOL);
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored
            .into_iter()
            .map(|(i, s)| (i, s, format!("semantic {s:.2}")))
            .collect()
    }
}

fn passage(index: &Index, i: usize) -> String {
    let c = &index.chunks[i];
    let end = c
        .text
        .char_indices()
        .nth(PASSAGE_CHARS)
        .map_or(c.text.len(), |(at, _)| at);
    let label = c
        .section
        .as_deref()
        .map(String::from)
        .unwrap_or_else(|| c.symbols.join(", "));
    format!("{} {}\n{}", c.path, label, &c.text[..end])
}

fn is_test(path: &str) -> bool {
    path.split('/').any(|part| {
        part == "tests" || part == "test" || part.starts_with("test_") || part.ends_with("_test.py")
    })
}

fn embeddable(c: &crate::index::ChunkRef) -> bool {
    let path = c.path.as_str();
    let data = [".json", ".csv", ".tsv", ".svg", ".lock", ".min.js", ".map"]
        .iter()
        .any(|ext| path.ends_with(ext));
    let fixture = path.split('/').any(|part| {
        matches!(
            part,
            "fixtures" | "fixture" | "testdata" | "__snapshots__" | "snapshots"
        )
    });
    !data && !fixture && c.text.trim().len() >= MIN_CHARS
}

fn load(file: &Path, fingerprint: u64) -> Option<HashMap<u64, Vector>> {
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .ok()?
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() < 20
        || &bytes[..8] != MAGIC
        || u64::from_le_bytes(bytes[8..16].try_into().ok()?) != fingerprint
    {
        return None;
    }
    let dim = u32::from_le_bytes(bytes[16..20].try_into().ok()?) as usize;
    let record = 12 + dim;
    let mut out = HashMap::new();
    for chunk in bytes[20..].chunks_exact(record) {
        let hash = u64::from_le_bytes(chunk[..8].try_into().ok()?);
        let scale = f32::from_le_bytes(chunk[8..12].try_into().ok()?);
        out.insert(
            hash,
            Vector {
                scale,
                values: chunk[12..].iter().map(|&b| b as i8).collect(),
            },
        );
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantized_cosine_tracks_float_cosine() {
        let a = vec![0.3, -0.5, 0.8, 0.1];
        let b = vec![0.29, -0.52, 0.79, 0.12];
        let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
        let exact = a.iter().zip(&b).map(|(x, y)| x * y).sum::<f32>() / (norm(&a) * norm(&b));
        assert!((cosine(&quantize(&a), &quantize(&b)) - exact).abs() < 0.01);
    }

    #[test]
    fn saved_vectors_reload_only_for_the_same_model() {
        let dir = std::env::temp_dir().join(format!("pointer-vectors-{}", std::process::id()));
        let file = dir.join(".pointer/index/vectors.bin");
        let semantic = Semantic {
            file: file.clone(),
            fingerprint: 7,
            model: std::sync::OnceLock::new(),
            vectors: RwLock::new(HashMap::from([(42, quantize(&[0.1, -0.2, 0.3]))])),
            queries: Mutex::new(HashMap::new()),
            done: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
            wake: Mutex::new(None),
        };
        semantic.save();
        let back = load(&file, 7).unwrap();
        assert_eq!(
            back[&42].values,
            semantic.vectors.read().unwrap()[&42].values
        );
        assert!(load(&file, 8).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
