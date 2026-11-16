import json, math, os, re, sys, time
root = sys.argv[1]; qs = json.load(open(os.path.join(os.path.dirname(__file__), "queries.json")))
STOP = set("a an the and or of to in for with is are be by on at as it this that from where how what which".split())
EXT = re.compile(r"\.(py|rst|md|txt|toml|cfg|html)$")
def tok(s): return [t for t in re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", s).lower()) if t and t not in STOP]
t0 = time.perf_counter(); docs = []
for d, ds, fs in os.walk(root):
    ds[:] = [x for x in ds if not x.startswith(".")]
    for f in fs:
        if not EXT.search(f) or f.startswith("."): continue
        p = os.path.join(d, f); rel = os.path.relpath(p, root); lines = open(p, encoding="utf8", errors="ignore").read().split("\n")
        for i in range(0, len(lines), 40):
            t = tok(rel + " " + "\n".join(lines[i:i+40])); tf = {}
            for w in t: tf[w] = tf.get(w, 0) + 1
            docs.append((rel, len(t), tf))
df = {}
for _, _, tf in docs:
    for w in tf: df[w] = df.get(w, 0) + 1
N = len(docs); avg = sum(d[1] for d in docs) / N
index = (time.perf_counter() - t0) * 1000; out = []
for q in qs:
    s = time.perf_counter(); terms = tok(q["q"]); scored = []
    for rel, n, tf in docs:
        sc = 0.0
        for w in terms:
            f = tf.get(w)
            if f: sc += math.log(1 + (N - df[w] + .5) / (df[w] + .5)) * f * 2.2 / (f + 1.2 * (.25 + .75 * n / avg))
        if sc > 0: scored.append((sc, rel))
    scored.sort(reverse=True); seen = []
    for _, r in scored:
        if r not in seen: seen.append(r)
    out.append({"ms": (time.perf_counter() - s) * 1000, "files": seen})
print(json.dumps({"index": index, "out": out}))
