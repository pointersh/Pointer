import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import esbuild from "esbuild"

const [flask, retrieval] = process.argv.slice(2)
if (!flask || !retrieval) throw new Error("usage: node preview/record.mjs <flask-3.1.3-checkout> <pointer-retrieval-binary>")
const here = path.dirname(new URL(import.meta.url).pathname)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-preview-"))
const root = path.join(work, "flask")
fs.cpSync(flask, root, { recursive: true, filter: (p) => !p.includes(`${path.sep}.pointer`) })

const PROMPT = "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."

const bundle = path.join(work, "server.cjs")
await esbuild.build({ entryPoints: [path.join(here, "../src/extension/mcp/server.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" })
const { startEditorMcp } = await import(pathToFileURL(bundle).href)

let diffs = []
const lineRange = (r) => (r.startLine === r.endLine ? `line ${r.startLine + 1}` : `lines ${r.startLine + 1}-${r.endLine + 1}`)
const edit = async (file, r) => {
  const lines = fs.readFileSync(file, "utf8").split("\n")
  lines.splice(r.startLine, r.endLine - r.startLine + 1, ...(r.text === "" ? [] : r.text.split("\n")))
  fs.writeFileSync(file, lines.join("\n"))
  const relative = path.relative(root, file)
  diffs.push({ file: relative, startLine: r.startLine, original: r.original, text: r.text })
  return { ok: true, pending: true, message: `Proposed: the change to ${relative} ${lineRange(r)} is shown in the editor for the user to accept or reject. It is not applied yet. Tell the user in a sentence what you changed.` }
}
const python = path.join(work, "venv/bin/python")
execFileSync("uv", ["venv", "-q", path.join(work, "venv")])
execFileSync("uv", ["pip", "install", "-q", "-p", python, "-e", root, "pytest==8.4.2", "asgiref", "greenlet", "python-dotenv"])
const run = async (command) => {
  try {
    const output = execFileSync("/bin/bash", ["-c", command], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${path.join(work, "venv/bin")}:${process.env.PATH}` } })
    return { ran: true, output, exitCode: 0 }
  } catch (error) {
    return { ran: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}`, exitCode: error.status ?? 1 }
  }
}
const editor = await startEditorMcp({ root, extras: { edits: { edit, create: edit }, commands: { run } } })

const engine = spawn(retrieval, ["--root", root], { stdio: ["ignore", "pipe", "inherit"] })
const [, retrievalUrl, retrievalToken] = await new Promise((resolve) =>
  engine.stdout.on("data", (d) => { const m = String(d).match(/READY (\S+) (\S+)/); if (m) resolve(m) })
)

const client = (url, token) => {
  let session
  const post = async (body) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) })
    session ??= res.headers.get("mcp-session-id") ?? undefined
    const text = await res.text()
    return text.startsWith("{") ? JSON.parse(text) : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === body.id)
  }
  return {
    init: async () => {
      await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "preview", version: "0" } } })
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined)
    },
    call: async (name, args) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result.content[0].text
  }
}
const pointer = client(retrievalUrl, retrievalToken)
await pointer.init()
const tools = client(editor.url, editor.token)

const steps = []
const think = (text) => steps.push({ kind: "think", text })
const say = (text) => steps.push({ kind: "text", text })
const tool = async (via, name, args, approval) => {
  diffs = []
  const output = await via.call(name, args)
  steps.push({ kind: "tool", name, args, output, ...(approval ? { approval } : {}), ...(diffs.length ? { diffs } : {}) })
}

think("The task needs a new CLI command, a test and docs. I don't know where the built-in commands live, so I'll search first.")
await tool(pointer, "search_codebase", { query: PROMPT })
think("cli.py defines the built-in commands and registers them in FlaskGroup. I'll read the routes command and the registration.")
await tool(tools, "read_file", { path: "src/flask/cli.py", start_line: "585", end_line: "600" })
await tool(tools, "read_file", { path: "src/flask/cli.py", start_line: "1100", end_line: "1120" })
await tool(tools, "edit_file", {
  path: "src/flask/cli.py",
  edits: JSON.stringify([
    { find: "import inspect\nimport os", replace: "import inspect\nimport json\nimport os" },
    { find: "            self.add_command(routes_command)\n", replace: "            self.add_command(routes_command)\n            self.add_command(config_command)\n" },
    {
      find: "        click.echo(template.format(*row))\n\n\ncli = FlaskGroup(",
      replace: `        click.echo(template.format(*row))


_SECRET_MARKERS = ("SECRET", "PASSWORD", "TOKEN", "KEY")


@click.command("config", short_help="Show the app's configuration as JSON.")
@with_appcontext
def config_command() -> None:
    """Show the loaded app's configuration as JSON. Values of keys
    containing SECRET, PASSWORD, TOKEN or KEY are shown as "***".
    """
    shown = {
        key: "***" if any(m in key.upper() for m in _SECRET_MARKERS) else value
        for key, value in current_app.config.items()
    }
    click.echo(json.dumps(shown, indent=2, sort_keys=True, default=str))


cli = FlaskGroup(`
    }
  ])
}, "change")
await tool(tools, "edit_file", {
  path: "tests/test_cli.py",
  edits: JSON.stringify([
    { find: "import importlib.metadata\nimport os", replace: "import importlib.metadata\nimport json\nimport os" },
    {
      find: "def test_run_exclude_patterns():",
      replace: `def test_config_command_masks_secrets():
    app = Flask(__name__)
    app.config.update(SECRET_KEY="dev", DB_PASSWORD="pw", API_TOKEN="t", GREETING="hi")
    result = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ["config"])
    assert result.exit_code == 0, result.output
    shown = json.loads(result.output)
    assert shown["SECRET_KEY"] == shown["DB_PASSWORD"] == shown["API_TOKEN"] == "***"
    assert shown["GREETING"] == "hi"


def test_config_command_in_help():
    app = Flask(__name__)
    result = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ["--help"])
    assert "config" in result.output


def test_run_exclude_patterns():`
    }
  ])
}, "change")
await tool(tools, "edit_file", {
  path: "docs/cli.rst",
  find: "Use :meth:`~Flask.shell_context_processor` to add other automatic imports.\n",
  replace: `Use :meth:\`~Flask.shell_context_processor\` to add other automatic imports.


Show the Configuration
----------------------

The :func:\`config <cli.config_command>\` command prints the loaded
application's configuration as JSON. Values of keys containing \`\`SECRET\`\`,
\`\`PASSWORD\`\`, \`\`TOKEN\`\` or \`\`KEY\`\` are shown as \`\`"***"\`\`. ::

    $ flask config
    {
      "DEBUG": false,
      "SECRET_KEY": "***",
      ...
    }
`
}, "change")
think("All three files are proposed. I'll run the CLI tests to check the new command and that nothing else broke.")
await tool(tools, "run_command", { command: "python -m pytest tests/test_cli.py -q" }, "command")
say("I added a built-in `flask config` command and checked it.\n\n- **`src/flask/cli.py`**: `config_command` prints `current_app.config` as JSON, masking any key containing `SECRET`, `PASSWORD`, `TOKEN` or `KEY` as `\"***\"`, and `FlaskGroup` registers it next to `routes`, so it shows in `flask --help`.\n- **`tests/test_cli.py`**: two tests, one for the masking and one for `--help`.\n- **`docs/cli.rst`**: a *Show the Configuration* section after *Open a Shell*.\n\nThe CLI tests pass. Each change is waiting in the editor for you to accept.")

const session = { recordedAt: new Date().toISOString(), flask: "pallets/flask 3.1.3", prompt: PROMPT, steps }
fs.writeFileSync(path.join(here, "session.json"), `${JSON.stringify(session, null, 1)}\n`)
console.log(`recorded ${steps.length} steps; pytest: ${steps.at(-2).output.trim().split("\n").at(-1)}`)
engine.kill()
await editor.dispose()
fs.rmSync(work, { recursive: true, force: true })
