use crate::index::Index;
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime};

const MAGIC: &[u8; 8] = b"PTRVEC01";
const BATCH: usize = 8;
const MAX_LENGTH: usize = 512;
const POOL: usize = 100;

struct Vector {
    scale: f32,
    values: Vec<i8>,
}

pub struct Semantic {
    file: PathBuf,
    model: Mutex<Option<TextEmbedding>>,
    vectors: RwLock<HashMap<u64, Vector>>,
    done: AtomicUsize,
    total: AtomicUsize,
    failed: AtomicBool,
    wake: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

fn quantize(mut v: Vec<f32>) -> Vector {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter_mut().for_each(|x| *x /= norm);
    let max = v.iter().fold(0f32, |m, x| m.max(x.abs())).max(1e-12);
    Vector { scale: max / 127.0, values: v.iter().map(|x| (x / max * 127.0).round() as i8).collect() }
}

fn cosine(query: &[f32], v: &Vector) -> f32 {
    query.iter().zip(&v.values).map(|(q, &x)| q * x as f32).sum::<f32>() * v.scale
}

fn cache_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".cache/pointer/fastembed")
}

impl Semantic {
    pub fn start(root: &Path, index: impl Fn() -> Arc<Index> + Send + 'static) -> Arc<Semantic> {
        let file = root.join(".pointer/index/vectors.bin");
        let semantic = Arc::new(Semantic {
            vectors: RwLock::new(load(&file).unwrap_or_default()),
            file,
            model: Mutex::new(None),
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
            let options = TextInitOptions::new(EmbeddingModel::JinaEmbeddingsV2BaseCode)
                .with_cache_dir(cache_dir())
                .with_max_length(MAX_LENGTH)
                .with_show_download_progress(false);
            match TextEmbedding::try_new(options) {
                Ok(model) => *worker.model.lock().unwrap() = Some(model),
                Err(error) => {
                    eprintln!("pointer-retrieval: semantic disabled, model failed to load: {error}");
                    worker.failed.store(true, Ordering::Relaxed);
                    return;
                }
            }
            eprintln!("pointer-retrieval: semantic model loaded in {:?}", started.elapsed());
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
        let mut missing: Vec<usize> = {
            let have = self.vectors.read().unwrap();
            index.chunks.iter().enumerate().filter(|(_, c)| !have.contains_key(&c.hash)).map(|(i, _)| i).collect()
        };
        self.total.store(index.chunks.len(), Ordering::Relaxed);
        self.done.store(index.chunks.len() - missing.len(), Ordering::Relaxed);
        if missing.is_empty() {
            return;
        }
        let mut mtimes: HashMap<&str, SystemTime> = HashMap::new();
        for &i in &missing {
            let path = index.chunks[i].path.as_str();
            mtimes.entry(path).or_insert_with(|| {
                std::fs::metadata(root.join(path)).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
            });
        }
        missing.sort_by(|a, b| mtimes[index.chunks[*b].path.as_str()].cmp(&mtimes[index.chunks[*a].path.as_str()]).then(a.cmp(b)));
        let count = missing.len();
        for (n, batch) in missing.chunks(BATCH).enumerate() {
            let texts: Vec<String> = batch.iter().map(|&i| passage(index, i)).collect();
            let embedded = match self.model.lock().unwrap().as_mut().map(|m| m.embed(&texts, Some(BATCH))) {
                Some(Ok(vectors)) => vectors,
                Some(Err(error)) => {
                    eprintln!("pointer-retrieval: embedding batch failed: {error}");
                    continue;
                }
                None => return,
            };
            {
                let mut have = self.vectors.write().unwrap();
                for (&i, v) in batch.iter().zip(embedded) {
                    have.insert(index.chunks[i].hash, quantize(v));
                }
            }
            self.done.fetch_add(batch.len(), Ordering::Relaxed);
            if n % 25 == 24 {
                self.save();
            }
        }
        self.save();
        eprintln!("pointer-retrieval: embedded {count} chunks in {:?}", started.elapsed());
    }

    fn save(&self) {
        let have = self.vectors.read().unwrap();
        let mut bytes = Vec::with_capacity(have.len() * 780 + 16);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(have.values().next().map_or(0, |v| v.values.len()) as u32).to_le_bytes());
        for (hash, v) in have.iter() {
            bytes.extend_from_slice(&hash.to_le_bytes());
            bytes.extend_from_slice(&v.scale.to_le_bytes());
            bytes.extend(v.values.iter().map(|&x| x as u8));
        }
        drop(have);
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(self.file.parent().unwrap())?;
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
        let (done, total) = (self.done.load(Ordering::Relaxed), self.total.load(Ordering::Relaxed));
        if total == 0 {
            "semantic: building 0% (loading model)".into()
        } else if done >= total {
            "semantic: ready".into()
        } else {
            format!("semantic: building {}% ({done}/{total})", done * 100 / total)
        }
    }

    pub fn memory_bytes(&self) -> usize {
        self.vectors.read().unwrap().values().map(|v| v.values.len() + 12).sum()
    }

    pub fn rank(&self, index: &Index, query: &str) -> Vec<(usize, f32, String)> {
        if self.vectors.read().unwrap().is_empty() {
            return Vec::new();
        }
        let Some(embedded) = self.model.lock().unwrap().as_mut().and_then(|m| m.embed([query], None).ok()) else {
            return Vec::new();
        };
        let Some(q) = embedded.into_iter().next().map(|v| {
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
            v.into_iter().map(|x| x / norm).collect::<Vec<f32>>()
        }) else {
            return Vec::new();
        };
        let have = self.vectors.read().unwrap();
        let mut scored: Vec<(usize, f32)> =
            index.chunks.iter().enumerate().filter_map(|(i, c)| have.get(&c.hash).map(|v| (i, cosine(&q, v)))).collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.into_iter().take(POOL).map(|(i, s)| (i, s, format!("semantic {s:.2}"))).collect()
    }
}

fn passage(index: &Index, i: usize) -> String {
    let c = &index.chunks[i];
    let label = c.section.as_deref().map(String::from).unwrap_or_else(|| c.symbols.join(", "));
    format!("{} {}\n{}", c.path, label, c.text)
}

fn load(file: &Path) -> Option<HashMap<u64, Vector>> {
    let mut bytes = Vec::new();
    std::fs::File::open(file).ok()?.read_to_end(&mut bytes).ok()?;
    if bytes.len() < 12 || &bytes[..8] != MAGIC {
        return None;
    }
    let dim = u32::from_le_bytes(bytes[8..12].try_into().ok()?) as usize;
    let record = 12 + dim;
    let mut out = HashMap::new();
    for chunk in bytes[12..].chunks_exact(record) {
        let hash = u64::from_le_bytes(chunk[..8].try_into().ok()?);
        let scale = f32::from_le_bytes(chunk[8..12].try_into().ok()?);
        out.insert(hash, Vector { scale, values: chunk[12..].iter().map(|&b| b as i8).collect() });
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
        let q: Vec<f32> = a.iter().map(|x| x / norm(&a)).collect();
        assert!((cosine(&q, &quantize(b)) - exact).abs() < 0.01);
    }
}
