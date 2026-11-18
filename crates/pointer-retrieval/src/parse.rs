use std::collections::HashMap;
use std::sync::Arc;
use tree_sitter::{Language, Node, Parser};

pub const MIN_TOKENS: usize = 150;
pub const MAX_TOKENS: usize = 400;
const WINDOW_LINES: usize = 60;

#[derive(Clone, Debug)]
pub struct Def {
    pub name: String,
    pub kind: &'static str,
    pub line: u32,
}

#[derive(Clone, Debug)]
pub struct Chunk {
    pub start: u32,
    pub end: u32,
    pub text: Arc<str>,
    pub symbols: Vec<String>,
    pub section: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub defs: Vec<Def>,
    pub chunks: Vec<Chunk>,
    pub idents: HashMap<String, Vec<u32>>,
}

pub fn tokens_of(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn language(path: &str) -> Option<Language> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "py" | "pyi" => tree_sitter_python::LANGUAGE.into(),
        "js" | "jsx" | "mjs" | "cjs" => tree_sitter_javascript::LANGUAGE.into(),
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => return None,
    })
}

fn def_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "function_definition"
        | "function_declaration"
        | "function_item"
        | "method_declaration"
        | "generator_function_declaration" => "function",
        "method_definition" => "method",
        "class_definition" | "class_declaration" | "abstract_class_declaration" => "class",
        "interface_declaration" | "trait_item" => "interface",
        "type_alias_declaration" | "type_item" | "type_declaration" => "type",
        "enum_declaration" | "enum_item" => "enum",
        "struct_item" => "struct",
        "impl_item" => "impl",
        "mod_item" => "module",
        "macro_definition" => "macro",
        "lexical_declaration" | "variable_declaration" => "const",
        _ => return None,
    })
}

fn text<'a>(node: Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

fn def_names(node: Node, src: &[u8]) -> Vec<String> {
    match node.kind() {
        "impl_item" => node
            .child_by_field_name("type")
            .map(|t| vec![text(t, src).to_string()])
            .unwrap_or_default(),
        "type_declaration" => {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .filter(|c| c.kind() == "type_spec")
                .filter_map(|c| c.child_by_field_name("name"))
                .map(|n| text(n, src).to_string())
                .collect()
        }
        "lexical_declaration" | "variable_declaration" => {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .filter(|c| c.kind() == "variable_declarator")
                .filter(|c| {
                    c.child_by_field_name("value").is_some_and(|v| {
                        matches!(
                            v.kind(),
                            "arrow_function" | "function_expression" | "function" | "class"
                        )
                    })
                })
                .filter_map(|c| c.child_by_field_name("name"))
                .map(|n| text(n, src).to_string())
                .collect()
        }
        _ => node
            .child_by_field_name("name")
            .map(|n| vec![text(n, src).to_string()])
            .unwrap_or_default(),
    }
}

const MAX_DEPTH: usize = 1000;

// The walks below recurse once per tree level; a deeply nested file (e.g. 50,000 parentheses) would
// overflow the stack and kill the server. Such files are chunked as plain lines instead.
fn shallow(node: Node) -> bool {
    let mut cursor = node.walk();
    let mut depth = 0usize;
    loop {
        if depth > MAX_DEPTH {
            return false;
        }
        if cursor.goto_first_child() {
            depth += 1;
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return true;
            }
            depth -= 1;
        }
    }
}

fn collect_defs(node: Node, src: &[u8], defs: &mut Vec<Def>) {
    if let Some(kind) = def_kind(node.kind()) {
        for name in def_names(node, src) {
            if !name.is_empty() {
                defs.push(Def {
                    name,
                    kind,
                    line: node.start_position().row as u32 + 1,
                });
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_defs(child, src, defs);
    }
}

fn unwrap_wrapper(node: Node) -> Node {
    if matches!(node.kind(), "export_statement" | "decorated_definition") {
        let mut cursor = node.walk();
        let inner = node
            .named_children(&mut cursor)
            .find(|c| def_kind(c.kind()).is_some() || c.child_by_field_name("body").is_some());
        if let Some(inner) = inner {
            return inner;
        }
    }
    node
}

#[derive(Clone, Copy)]
struct Seg<'t> {
    start: usize,
    end: usize,
    node: Option<Node<'t>>,
}

fn line_starts(src: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(src.match_indices('\n').map(|(i, _)| i + 1))
        .collect()
}

struct Chunker<'a> {
    src: &'a str,
    starts: Vec<usize>,
    defs: &'a [Def],
    out: Vec<Chunk>,
}

impl Chunker<'_> {
    fn line_of(&self, byte: usize) -> usize {
        self.starts
            .partition_point(|&s| s <= byte)
            .saturating_sub(1)
    }

    fn emit_lines(&mut self, first: usize, last: usize) {
        let from = self.starts[first];
        let to = self.starts.get(last + 1).copied().unwrap_or(self.src.len());
        let body = &self.src[from..to];
        if body.trim().is_empty() {
            return;
        }
        let (start, end) = (first as u32 + 1, last as u32 + 1);
        let symbols = self
            .defs
            .iter()
            .filter(|d| d.line >= start && d.line <= end)
            .map(|d| d.name.clone())
            .collect();
        self.out.push(Chunk {
            start,
            end,
            text: body.trim_end().into(),
            symbols,
            section: None,
        });
    }

    fn emit(&mut self, start: usize, end: usize) {
        let end = start + self.src[start..end].trim_end().len();
        if end <= start {
            return;
        }
        let mut first = self.line_of(start);
        let line_end = self
            .starts
            .get(first + 1)
            .copied()
            .unwrap_or(self.src.len());
        if self.src[start..line_end.min(end).max(start)]
            .trim()
            .is_empty()
            && line_end < end
        {
            first += 1;
        }
        let last = self.line_of(end.saturating_sub(1).max(start));
        if last > first && tokens_of(&self.src[start..end]) > MAX_TOKENS {
            let mut line = first;
            while line <= last {
                let stop = (line + WINDOW_LINES - 1).min(last);
                self.emit_lines(line, stop);
                line = stop + 1;
            }
        } else {
            self.emit_lines(first, last);
        }
    }

    fn segments<'t>(&self, node: Node<'t>, from: usize, to: usize) -> Vec<Seg<'t>> {
        let mut segs = Vec::new();
        let mut at = from;
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.start_byte() > at {
                segs.push(Seg {
                    start: at,
                    end: child.start_byte(),
                    node: None,
                });
            }
            let inner = unwrap_wrapper(child);
            let is_def = def_kind(inner.kind()).is_some();
            segs.push(Seg {
                start: child.start_byte(),
                end: child.end_byte(),
                node: is_def.then_some(inner),
            });
            at = child.end_byte();
        }
        if to > at {
            segs.push(Seg {
                start: at,
                end: to,
                node: None,
            });
        }
        segs
    }

    fn pack(&mut self, segs: Vec<Seg>) {
        let mut pending: Option<(usize, usize)> = None;
        for seg in segs {
            let size = tokens_of(&self.src[seg.start..seg.end]);
            if size > MAX_TOKENS {
                if let Some((s, e)) = pending.take() {
                    self.emit(s, e);
                }
                match seg
                    .node
                    .and_then(|n| n.child_by_field_name("body").map(|b| (n, b)))
                {
                    Some((node, body)) if body.named_child_count() > 1 => {
                        let mut inner = vec![Seg {
                            start: seg.start,
                            end: body.start_byte(),
                            node: None,
                        }];
                        inner.extend(self.segments(body, body.start_byte(), body.end_byte()));
                        inner.push(Seg {
                            start: body.end_byte(),
                            end: seg.end.max(node.end_byte()),
                            node: None,
                        });
                        self.pack(inner);
                    }
                    _ => self.emit(seg.start, seg.end),
                }
                continue;
            }
            if seg.node.is_some() && size >= MIN_TOKENS {
                if let Some((s, e)) = pending.take() {
                    self.emit(s, e);
                }
                self.emit(seg.start, seg.end);
                continue;
            }
            pending = match pending {
                Some((s, _)) if tokens_of(&self.src[s..seg.end]) > MAX_TOKENS => {
                    let (ps, pe) = pending.unwrap();
                    self.emit(ps, pe);
                    Some((seg.start, seg.end))
                }
                Some((s, _)) => Some((s, seg.end)),
                None => Some((seg.start, seg.end)),
            };
        }
        if let Some((s, e)) = pending {
            self.emit(s, e);
        }
    }
}

pub fn idents(src: &str) -> HashMap<String, Vec<u32>> {
    let mut map: HashMap<String, Vec<u32>> = HashMap::new();
    for (i, line) in src.lines().enumerate() {
        for word in line.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
            if word.len() >= 3 && !word.starts_with(|c: char| c.is_ascii_digit()) {
                let lines = map.entry(word.to_string()).or_default();
                if lines.last() != Some(&(i as u32 + 1)) {
                    lines.push(i as u32 + 1);
                }
            }
        }
    }
    map
}

fn is_prose(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "rst" | "txt" | "mdx")
    )
}

fn is_underline(line: &str, title: &str) -> bool {
    let line = line.trim_end();
    let first = line.chars().next();
    line.len() >= 3
        && line.len() >= title.trim().chars().count()
        && first.is_some_and(|c| "=-~^\"'*+#`".contains(c))
        && line.chars().all(|c| Some(c) == first)
}

pub fn sections(src: &str) -> Vec<(usize, String)> {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(title) = line
            .strip_prefix('#')
            .map(|t| t.trim_start_matches('#').trim())
            .filter(|t| !t.is_empty())
        {
            out.push((i, title.to_string()));
        } else if !line.trim().is_empty()
            && lines
                .get(i + 1)
                .is_some_and(|next| is_underline(next, line))
            && !is_underline(line, "")
        {
            out.push((i, line.trim().to_string()));
        }
    }
    out
}

fn chunk_prose(src: &str) -> Vec<Chunk> {
    let starts = line_starts(src);
    let total = src.lines().count();
    let mut bounds = sections(src);
    if bounds.first().map(|b| b.0) != Some(0) {
        bounds.insert(0, (0, String::new()));
    }
    let mut out = Vec::new();
    for (k, (first, title)) in bounds.iter().enumerate() {
        let last = bounds
            .get(k + 1)
            .map(|b| b.0)
            .unwrap_or(total)
            .saturating_sub(1);
        let mut line = *first;
        while line <= last && line < total {
            let mut stop = line;
            while stop < last
                && tokens_of(&src[starts[line]..starts.get(stop + 2).copied().unwrap_or(src.len())])
                    <= MAX_TOKENS
            {
                stop += 1;
            }
            let body = &src[starts[line]..starts.get(stop + 1).copied().unwrap_or(src.len())];
            if !body.trim().is_empty() {
                let section = (!title.is_empty()).then(|| title.clone());
                out.push(Chunk {
                    start: line as u32 + 1,
                    end: stop as u32 + 1,
                    text: body.trim_end().into(),
                    symbols: Vec::new(),
                    section,
                });
            }
            line = stop + 1;
        }
    }
    out
}

pub fn parse(path: &str, src: &str) -> Parsed {
    if is_prose(path) {
        return Parsed {
            idents: HashMap::new(),
            defs: Vec::new(),
            chunks: chunk_prose(src),
        };
    }
    let mut defs = Vec::new();
    let tree = language(path)
        .and_then(|lang| {
            let mut parser = Parser::new();
            parser.set_language(&lang).ok()?;
            parser.parse(src, None)
        })
        .filter(|tree| shallow(tree.root_node()));
    if let Some(tree) = &tree {
        collect_defs(tree.root_node(), src.as_bytes(), &mut defs);
    }
    let mut chunker = Chunker {
        src,
        starts: line_starts(src),
        defs: &defs,
        out: Vec::new(),
    };
    match &tree {
        Some(tree) => {
            let root = tree.root_node();
            let segs = chunker.segments(root, 0, src.len());
            chunker.pack(segs);
        }
        None => chunker.emit(0, src.len()),
    }
    let chunks = chunker.out;
    Parsed {
        idents: idents(src),
        defs,
        chunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_defs_and_chunks() {
        let src = "import os\n\nclass AppGroup:\n    def command(self):\n        return 1\n\ndef run():\n    pass\n";
        let parsed = parse("cli.py", src);
        let names: Vec<_> = parsed.defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["AppGroup", "command", "run"]);
        assert!(parsed
            .chunks
            .iter()
            .any(|c| c.symbols.contains(&"AppGroup".to_string())));
        assert_eq!(parsed.chunks.first().unwrap().start, 1);
    }

    #[test]
    fn huge_function_splits_into_windows() {
        let body: String = (0..400)
            .map(|i| format!("    x{i} = {i} + {i}\n"))
            .collect();
        let src = format!("def big():\n{body}");
        let parsed = parse("big.py", &src);
        assert!(parsed.chunks.len() > 1);
        let sizes: Vec<_> = parsed
            .chunks
            .iter()
            .map(|c| (c.start, c.end, tokens_of(&c.text)))
            .collect();
        assert!(sizes.iter().all(|s| s.2 <= MAX_TOKENS + 20), "{sizes:?}");
        assert!(sizes.windows(2).all(|w| w[0].1 < w[1].0), "{sizes:?}");
    }

    #[test]
    fn unknown_language_falls_back_to_lines() {
        let parsed = parse("notes.ini", "[a]\nb = 1\n");
        assert_eq!(parsed.chunks.len(), 1);
        assert!(parsed.defs.is_empty());
    }

    #[test]
    fn docs_chunk_by_section() {
        let src = "Title\n=====\n\nIntro.\n\nCustom Commands\n---------------\n\nUse @app.cli.command.\n\n## Plugins\n\nEntry points.\n";
        let rst = parse("cli.rst", src);
        let titles: Vec<_> = rst
            .chunks
            .iter()
            .map(|c| c.section.clone().unwrap_or_default())
            .collect();
        assert_eq!(titles, ["Title", "Custom Commands", "Plugins"]);
        assert_eq!(rst.chunks[1].start, 6);
        assert!(rst.chunks[1].text.contains("app.cli.command"));
        assert!(rst.defs.is_empty());
    }
}
