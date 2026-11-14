use crate::parse::{tokens_of, Def, Parsed};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;

const STOP: &[&str] = &[
    "the", "and", "for", "with", "this", "that", "from", "into", "add", "new", "use", "get", "set", "self", "def", "return",
    "import", "const", "let", "var", "function", "class", "pub", "fn", "is", "are", "was", "to", "of", "in", "on", "an", "it",
];
const RRF_K: f32 = 60.0;
const POOL: usize = 40;

pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        if word.is_empty() {
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        let mut current = String::new();
        let chars: Vec<char> = word.chars().collect();
        for (i, &c) in chars.iter().enumerate() {
            let boundary = i > 0
                && c.is_uppercase()
                && (chars[i - 1].is_lowercase() || chars[i - 1].is_ascii_digit() || chars.get(i + 1).is_some_and(|n| n.is_lowercase()));
            if boundary && !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            current.extend(c.to_lowercase());
        }
        if !current.is_empty() {
            parts.push(current);
        }
        let whole = word.to_lowercase();
        if parts.len() > 1 && whole.len() >= 2 {
            out.push(whole);
        }
        out.extend(parts.into_iter().filter(|p| p.len() >= 2 && !STOP.contains(&p.as_str())));
    }
    out
}

pub struct FileData {
    pub hash: u64,
    pub parsed: Parsed,
}

pub struct ChunkRef {
    pub path: String,
    pub start: u32,
    pub end: u32,
    pub text: String,
    pub symbols: Vec<String>,
    pub symbol_tokens: Vec<Vec<String>>,
    pub tokens: usize,
}

pub struct Index {
    pub chunks: Vec<ChunkRef>,
    postings: HashMap<String, Vec<(usize, f32)>>,
    lengths: Vec<f32>,
    avg_len: f32,
    pub defs: BTreeMap<String, Vec<(String, Def)>>,
    pub idents: HashMap<String, Vec<(String, u32)>>,
    pub rank: HashMap<String, f32>,
    pub files: usize,
}

pub struct Hit {
    pub chunk: usize,
    pub score: f32,
    pub signals: Vec<String>,
}

pub trait Signal {
    fn rank(&self, index: &Index, query: &[String]) -> Vec<(usize, f32, String)>;
}

struct Bm25;
struct Symbols;

impl Signal for Bm25 {
    fn rank(&self, index: &Index, query: &[String]) -> Vec<(usize, f32, String)> {
        index
            .bm25(query)
            .into_iter()
            .map(|(chunk, score, terms)| (chunk, score, format!("BM25 {score:.1} on \"{}\"", terms.join(" "))))
            .collect()
    }
}

impl Signal for Symbols {
    fn rank(&self, index: &Index, query: &[String]) -> Vec<(usize, f32, String)> {
        let wanted: HashSet<&str> = query.iter().map(String::as_str).collect();
        let mut out: Vec<(usize, f32, String)> = index
            .chunks
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let (score, name) = c
                    .symbols
                    .iter()
                    .zip(&c.symbol_tokens)
                    .map(|(s, parts)| {
                        let hit = parts.iter().filter(|p| wanted.contains(p.as_str())).count() as f32;
                        let exact = if wanted.contains(s.to_lowercase().as_str()) { 2.0 } else { 0.0 };
                        (hit / parts.len().max(1) as f32 + exact, s)
                    })
                    .max_by(|a, b| a.0.total_cmp(&b.0))?;
                (score > 0.0).then(|| (i, score, format!("name {name} matches")))
            })
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }
}

impl Index {
    pub fn build(files: &HashMap<String, FileData>) -> Index {
        let mut chunks = Vec::new();
        let mut defs: BTreeMap<String, Vec<(String, Def)>> = BTreeMap::new();
        let mut idents: HashMap<String, Vec<(String, u32)>> = HashMap::new();
        let mut paths: Vec<&String> = files.keys().collect();
        paths.sort();
        for path in &paths {
            let parsed = &files[*path].parsed;
            for chunk in &parsed.chunks {
                chunks.push(ChunkRef {
                    path: (*path).clone(),
                    start: chunk.start,
                    end: chunk.end,
                    tokens: tokens_of(&chunk.text),
                    text: chunk.text.clone(),
                    symbol_tokens: chunk.symbols.iter().map(|s| tokenize(s)).collect(),
                    symbols: chunk.symbols.clone(),
                });
            }
            for def in &parsed.defs {
                defs.entry(def.name.clone()).or_default().push(((*path).clone(), def.clone()));
            }
            for (word, lines) in &parsed.idents {
                if defs_name_like(word) {
                    let entry = idents.entry(word.clone()).or_default();
                    entry.extend(lines.iter().map(|&l| ((*path).clone(), l)));
                }
            }
        }
        idents.retain(|word, _| defs.contains_key(word));

        let mut postings: HashMap<String, Vec<(usize, f32)>> = HashMap::new();
        let mut lengths = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            let mut counts: HashMap<String, f32> = HashMap::new();
            let path_tokens = tokenize(&chunk.path);
            for token in path_tokens.iter().chain(path_tokens.iter()).cloned().chain(chunk.symbols.iter().flat_map(|s| tokenize(s))).chain(tokenize(&chunk.text)) {
                *counts.entry(token).or_default() += 1.0;
            }
            lengths.push(counts.values().sum());
            for (token, tf) in counts {
                postings.entry(token).or_default().push((i, tf));
            }
        }
        let avg_len = if lengths.is_empty() { 1.0 } else { lengths.iter().sum::<f32>() / lengths.len() as f32 };
        let rank = pagerank(files.keys(), &defs, &idents);
        Index { chunks, postings, lengths, avg_len, defs, idents, rank, files: files.len() }
    }

    pub fn bm25(&self, query: &[String]) -> Vec<(usize, f32, Vec<String>)> {
        let n = self.chunks.len() as f32;
        let mut scores: HashMap<usize, (f32, Vec<String>)> = HashMap::new();
        let unique: HashSet<&String> = query.iter().collect();
        for term in unique {
            let Some(list) = self.postings.get(term) else { continue };
            let idf = ((n - list.len() as f32 + 0.5) / (list.len() as f32 + 0.5) + 1.0).ln();
            for &(chunk, tf) in list {
                let norm = tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * self.lengths[chunk] / self.avg_len));
                let entry = scores.entry(chunk).or_default();
                entry.0 += idf * norm;
                entry.1.push(term.clone());
            }
        }
        let mut out: Vec<_> = scores.into_iter().map(|(c, (s, mut t))| {
            t.sort();
            (c, s, t)
        }).collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        out
    }

    pub fn referenced_by(&self, chunk: &ChunkRef) -> usize {
        chunk
            .symbols
            .iter()
            .filter(|s| !s.starts_with("test") && self.defs.get(*s).is_some_and(|d| d.len() <= 3))
            .filter_map(|s| self.idents.get(s))
            .flat_map(|refs| refs.iter().map(|(p, _)| p))
            .filter(|p| **p != chunk.path)
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn search(&self, query: &str, extra: &[&dyn Signal]) -> Vec<Hit> {
        let terms = tokenize(query);
        let mut signals: Vec<&dyn Signal> = vec![&Bm25, &Symbols];
        signals.extend_from_slice(extra);
        let mut fused: HashMap<usize, (f32, Vec<String>)> = HashMap::new();
        for signal in signals {
            for (rank, (chunk, _, why)) in signal.rank(self, &terms).into_iter().take(100).enumerate() {
                let entry = fused.entry(chunk).or_default();
                entry.0 += 1.0 / (RRF_K + rank as f32 + 1.0);
                entry.1.push(why);
            }
        }
        let mut central: Vec<usize> = fused.keys().copied().collect();
        central.sort_by(|a, b| self.file_rank(*b).total_cmp(&self.file_rank(*a)).then(a.cmp(b)));
        for (rank, chunk) in central.into_iter().enumerate() {
            fused.get_mut(&chunk).unwrap().0 += 0.5 / (RRF_K + rank as f32 + 1.0);
        }
        let mut hits: Vec<Hit> = fused.into_iter().map(|(chunk, (score, signals))| Hit { chunk, score, signals }).collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.chunk.cmp(&b.chunk)));
        hits
    }

    fn file_rank(&self, chunk: usize) -> f32 {
        self.rank.get(&self.chunks[chunk].path).copied().unwrap_or(0.0)
    }

    pub fn reason(&self, hit: &Hit) -> String {
        let chunk = &self.chunks[hit.chunk];
        let mut parts = Vec::new();
        if !chunk.symbols.is_empty() {
            let shown: Vec<_> = chunk.symbols.iter().take(3).cloned().collect();
            parts.push(format!("defines {}", shown.join(", ")));
            let refs = self.referenced_by(chunk);
            if refs > 0 {
                parts.push(format!("referenced by {refs} file{}", if refs == 1 { "" } else { "s" }));
            }
        }
        parts.extend(hit.signals.iter().filter(|s| !s.starts_with("name ")).cloned());
        if parts.is_empty() {
            parts.extend(hit.signals.iter().cloned());
        }
        parts.join("; ")
    }

    pub fn search_text(&self, query: &str, budget: usize, extra: &[&dyn Signal]) -> String {
        let hits = self.search(query, extra);
        if hits.is_empty() {
            return format!("Pointing at: nothing matched \"{query}\" in {} files.", self.files);
        }
        let pool: Vec<&Hit> = hits.iter().take(POOL).collect();
        let (chosen, dropped) = pack(&pool, budget, |h| self.chunks[h.chunk].tokens + 12);
        let mut out = String::from("Pointing at:\n");
        for hit in &chosen {
            let c = &self.chunks[hit.chunk];
            let _ = writeln!(out, "{}:{}-{} · {:.3} · {}", c.path, c.start, c.end, hit.score, self.reason(hit));
        }
        for hit in &chosen {
            let c = &self.chunks[hit.chunk];
            let _ = write!(out, "\n--- {}:{}-{}\n{}\n", c.path, c.start, c.end, c.text);
        }
        let _ = write!(out, "\ndropped {dropped} lower-ranked chunks");
        out
    }

    pub fn find_symbol(&self, name: &str) -> String {
        let Some(defs) = self.defs.get(name) else {
            return format!("No definition of {name} found.");
        };
        let mut out = String::from("Definitions:\n");
        let def_lines: HashSet<(&String, u32)> = defs.iter().map(|(p, d)| (p, d.line)).collect();
        for (path, def) in defs.iter().take(20) {
            let _ = writeln!(out, "{path}:{} · {} {}", def.line, def.kind, def.name);
        }
        let refs: Vec<&(String, u32)> = self
            .idents
            .get(name)
            .map(|r| r.iter().filter(|(p, l)| !def_lines.contains(&(p, *l))).collect())
            .unwrap_or_default();
        let _ = writeln!(out, "\nReferences ({}):", refs.len());
        for (path, line) in refs.iter().take(40) {
            let _ = writeln!(out, "{path}:{line}");
        }
        if refs.len() > 40 {
            let _ = writeln!(out, "… {} more", refs.len() - 40);
        }
        out
    }

    pub fn repo_map(&self, budget: usize) -> String {
        let mut files: Vec<(&String, f32)> = self.rank.iter().map(|(p, r)| (p, *r)).collect();
        files.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
        let mut by_file: HashMap<&String, Vec<&Def>> = HashMap::new();
        for entries in self.defs.values() {
            for (path, def) in entries {
                by_file.entry(path).or_default().push(def);
            }
        }
        let mut out = String::new();
        let mut used = 0;
        let mut shown = 0;
        for (path, rank) in &files {
            let Some(defs) = by_file.get_mut(path) else { continue };
            defs.sort_by_key(|d| d.line);
            let mut block = format!("{path} (rank {:.3})\n", rank);
            for def in defs.iter().take(12) {
                let _ = writeln!(block, "  {} {}:{}", def.kind, def.name, def.line);
            }
            let cost = tokens_of(&block);
            if used + cost > budget {
                continue;
            }
            used += cost;
            shown += 1;
            out.push_str(&block);
        }
        let _ = write!(out, "\n{shown} of {} files shown, ranked by PageRank over references", self.files);
        out
    }
}

fn defs_name_like(word: &str) -> bool {
    word.len() >= 3
}

pub fn pack<T: Copy>(items: &[T], budget: usize, cost: impl Fn(T) -> usize) -> (Vec<T>, usize) {
    let mut chosen = Vec::new();
    let mut used = 0;
    let mut dropped = 0;
    for &item in items {
        let c = cost(item);
        if used + c <= budget {
            used += c;
            chosen.push(item);
        } else {
            dropped += 1;
        }
    }
    (chosen, dropped)
}

fn pagerank<'a>(
    paths: impl Iterator<Item = &'a String>,
    defs: &BTreeMap<String, Vec<(String, Def)>>,
    idents: &HashMap<String, Vec<(String, u32)>>,
) -> HashMap<String, f32> {
    let nodes: Vec<&String> = paths.collect();
    let id: HashMap<&String, usize> = nodes.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let n = nodes.len();
    if n == 0 {
        return HashMap::new();
    }
    let mut out: Vec<HashMap<usize, f32>> = vec![HashMap::new(); n];
    for (name, refs) in idents {
        let Some(targets) = defs.get(name) else { continue };
        let referencing: HashSet<&String> = refs.iter().map(|(p, _)| p).collect();
        if referencing.len() * 10 > n.max(20) {
            continue;
        }
        let def_files: HashSet<usize> = targets.iter().filter_map(|(p, _)| id.get(p).copied()).collect();
        let weight = 1.0 / def_files.len() as f32;
        let mut counts: HashMap<usize, f32> = HashMap::new();
        for (path, _) in refs {
            if let Some(&from) = id.get(path) {
                *counts.entry(from).or_default() += 1.0;
            }
        }
        for (from, count) in counts {
            for &to in &def_files {
                if to != from {
                    *out[from].entry(to).or_default() += weight * count.sqrt();
                }
            }
        }
    }
    let totals: Vec<f32> = out.iter().map(|m| m.values().sum()).collect();
    let mut rank = vec![1.0 / n as f32; n];
    for _ in 0..30 {
        let dangling: f32 = (0..n).filter(|&i| totals[i] == 0.0).map(|i| rank[i]).sum();
        let mut next = vec![(0.15 + 0.85 * dangling) / n as f32; n];
        for (from, edges) in out.iter().enumerate() {
            if totals[from] == 0.0 {
                continue;
            }
            for (&to, &w) in edges {
                next[to] += 0.85 * rank[from] * w / totals[from];
            }
        }
        rank = next;
    }
    nodes.into_iter().cloned().zip(rank).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    fn index(files: &[(&str, &str)]) -> Index {
        let map = files
            .iter()
            .map(|(p, s)| (p.to_string(), FileData { hash: 0, parsed: parse(p, s) }))
            .collect();
        Index::build(&map)
    }

    #[test]
    fn tokenizer_splits_identifiers() {
        assert_eq!(tokenize("getHTTPServer"), ["gethttpserver", "http", "server"]);
        assert_eq!(tokenize("load_dotenv cli.py"), ["load", "dotenv", "cli", "py"]);
        assert_eq!(tokenize("AppGroup"), ["appgroup", "app", "group"]);
    }

    #[test]
    fn bm25_prefers_the_matching_chunk() {
        let idx = index(&[
            ("a.py", "def parse_config(path):\n    return open(path).read()\n"),
            ("b.py", "def render_page(template):\n    return template.upper()\n"),
        ]);
        let top = idx.bm25(&tokenize("render template page"));
        assert_eq!(idx.chunks[top[0].0].path, "b.py");
    }

    #[test]
    fn pack_respects_budget() {
        let (chosen, dropped) = pack(&[100usize, 300, 50, 200], 400, |c| c);
        assert_eq!(chosen, [100, 300]);
        assert_eq!(dropped, 2);
    }

    #[test]
    fn search_finds_definition_with_reason() {
        let idx = index(&[
            ("src/cli.py", "class AppGroup:\n    def command(self, name):\n        return name\n"),
            ("src/app.py", "from .cli import AppGroup\n\ncli = AppGroup()\n"),
            ("src/util.py", "def helper():\n    return 1\n"),
        ]);
        let text = idx.search_text("AppGroup command", 2000, &[]);
        let first = text.lines().nth(1).unwrap();
        assert!(first.starts_with("src/cli.py:1-3"), "{text}");
        assert!(first.contains("defines AppGroup"), "{first}");
        assert!(first.contains("referenced by 1 file"), "{first}");
        assert!(first.contains("BM25"), "{first}");
        assert!(idx.find_symbol("AppGroup").contains("src/app.py:3"));
        assert!(idx.repo_map(500).starts_with("src/cli.py"));
    }
}
