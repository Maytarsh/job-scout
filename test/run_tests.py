#!/usr/bin/env python3
"""Run test/logic_tests.js against the .gs sources in headless Firefox.

Apps Script has no local runtime, so this loads the source files into a real JS
engine with the Google services stubbed out. Covers pure logic only - anything
touching Sheets, Drive, Gmail or the API is exercised in the Apps Script editor.
"""
import glob, json, logging, os, sys
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

STUBS = """
var Logger = { log: function () {} };
var Utilities = {
  sleep: function () {},
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  base64Encode: function (bytes) { return 'base64:' + (bytes || []).length; },
  // Not real SHA-256. The tests care that a key maps to a stable 32-character
  // id and that two different keys do not collide, neither of which needs the
  // real digest - and Apps Script's own implementation is not available here.
  computeDigest: function (algorithm, value) {
    var out = [], h = 2166136261;
    for (var i = 0; i < String(value).length; i++) {
      h = (h ^ String(value).charCodeAt(i)) * 16777619 & 0xffffffff;
    }
    for (var b = 0; b < 32; b++) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      out.push(h % 256);
    }
    return out;
  }
};
var UrlFetchApp = { fetch: function () { throw new Error('no network in logic tests'); } };
var SpreadsheetApp = { getActive: function () { throw new Error('no sheet in logic tests'); } };
var ScriptApp = { getProjectTriggers: function () { return []; } };
var DriveApp = { getFileById: function () { throw new Error('no drive in logic tests'); } };
var MailApp = { sendEmail: function () {}, getRemainingDailyQuota: function () { return 100; } };
var Session = { getActiveUser: function () { return { getEmail: function () { return ''; } }; } };
var PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function () { return 'stub-key'; },
      setProperty: function () {},
      deleteProperty: function () {}
    };
  }
};
"""


def build_page():
    """Write the harness to a real file - Firefox refuses top-level data: URLs."""
    src = [STUBS, fixtures_literal()]
    # Alphabetical, because that is the order Apps Script evaluates project
    # files in - NOT dependency order. Loading them any other way here would
    # hide load-order bugs that would then only show up in production.
    for path in sorted(glob.glob(os.path.join(SRC, '*.gs'))):
        with open(path, encoding='utf-8') as fh:
            src.append(fh.read())
    with open(os.path.join(ROOT, 'test', 'logic_tests.js'), encoding='utf-8') as fh:
        src.append(fh.read())

    # Every "</script" in the assembled source is escaped. The sources and the
    # tests both contain that sequence inside ordinary string literals - a
    # fixture is a whole saved page, and the extraction tests are about script
    # tags - and the browser's HTML parser does not care that it sits inside a
    # string: it closes the harness's own script tag there and parses the rest
    # of the suite as body text. Nothing is defined, window.loadError stays null
    # because the try block never ran, and the failure reads as "no results"
    # with no error anywhere to explain it. In JavaScript the escaped form is
    # the same two characters inside a string, so nothing that executes changes.
    body = "\n;\n".join(src).replace("</script", r"<\/script")

    page = (
        "<!doctype html><meta charset=utf-8><title>logic tests</title>\n"
        "<script>\nwindow.loadError = null;\ntry {\n"
        + body
        + "\n} catch (e) { window.loadError = String(e && e.stack || e); }\n</script>"
    )
    # Inside the repo, not /tmp: the snap-confined browser can read $HOME.
    path = os.path.join(ROOT, 'test', '.harness.html')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(page)
    return 'file://' + path


def fixtures_literal():
    """Saved pages, injected as a JS object rather than read from disk.

    The HTML-to-text pipeline is the one part of this codebase whose input is
    genuinely adversarial - minified markup, unclosed tags, entity-encoded
    entities, a hundred lines of analytics - and inline test strings only ever
    contain what the person writing the test already thought of. These are real
    saved page shapes, so the tests are about pages rather than about strings.
    The browser cannot read them itself under file:// on every platform, so
    they are serialised in.
    """
    fixtures = {}
    for path in sorted(glob.glob(os.path.join(ROOT, 'test', 'fixtures', '*.html'))):
        with open(path, encoding='utf-8') as fh:
            fixtures[os.path.basename(path)] = fh.read()
    return 'var FIXTURES = ' + json.dumps(fixtures) + ';'


def _strip_comments(text, marker):
    """Drop line comments so prose in them cannot look like a payload key."""
    out = []
    for line in text.splitlines():
        i = line.find(marker)
        out.append(line if i < 0 else line[:i])
    return "\n".join(out)


def _between(text, start, end):
    i = text.index(start)
    return text[i + len(start):text.index(end, i + len(start))]


def _probe_constants(raw_src):
    """Top-level literal constants of tools/probe.py, read rather than imported.

    Importing it was the obvious way and it is wrong twice: exec_module goes
    through the bytecode cache, so an edit landing in the same second as its
    .pyc is read straight past - the check then validates a probe that is no
    longer on disk - and running the logic suite should not execute a file
    whose whole purpose is to bill the API.
    """
    import ast
    consts = {}
    for node in ast.parse(raw_src).body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)):
            try:
                consts[node.targets[0].id] = ast.literal_eval(node.value)
            except ValueError:
                pass   # not a literal (a call, an f-string) - nothing to compare
    return consts


def check_probe_drift():
    """tools/probe.py restates the scoring payload so it can run standalone and
    stdlib-only. Everything it restates is compared here. A probe that sends
    what production no longer sends proves nothing about production - and the
    drift is invisible, because both files keep working on their own.

    Compared: the scoring schema's field names, required list and
    additionalProperties; the mirrored Config.gs constants and price table; and
    the batch request's top-level keys and max_tokens. Prompt text is
    deliberately not compared - wording is the one thing the API does not care
    about the shape of, and pinning it here would make every reword a test fix.
    """
    import re
    gs = _strip_comments(
        open(os.path.join(SRC, 'Claude.gs'), encoding='utf-8').read(), '//')
    cfg = _strip_comments(
        open(os.path.join(SRC, 'Config.gs'), encoding='utf-8').read(), '//')
    raw_py = open(os.path.join(ROOT, 'tools', 'probe.py'), encoding='utf-8').read()
    # Comments stripped for the text scans below; ast gets the raw source, since
    # stripping on '#' would cut into any string literal containing one.
    py_src = _strip_comments(raw_py, '#')
    probe = _probe_constants(raw_py)

    fails = []

    def compare(label, expected, actual):
        if expected == actual:
            print(f"  PASS  probe {label}")
            return
        fails.append(label)
        print(f"  FAIL  probe {label} has drifted from src/")
        if isinstance(expected, set):
            print(f"        only in src/:      {sorted(expected - actual)}")
            print(f"        only in probe.py:  {sorted(actual - expected)}")
        else:
            print(f"        src/:      {expected!r}")
            print(f"        probe.py:  {actual!r}")

    def cfg_str(name):
        return re.search(r"^  %s: '([^']*)'" % name, cfg, re.M).group(1)

    def cfg_num(name):
        return float(re.search(r"^  %s: ([\d.]+)" % name, cfg, re.M).group(1))

    # 1. The scoring schema. A field name matching while an enum or an
    #    additionalProperties is missing is exactly the shape of drift that
    #    keeps both files working on their own while the API stops enforcing
    #    anything - so the guarantees are compared, not only the names.
    gs_schema = _between(gs, 'function scoreSchema_', 'function draftSchema_')
    py_schema = _between(py_src, 'SCORE_SCHEMA = {', 'BATCH_MAX_TOKENS')
    compare('score schema fields',
            set(re.findall(r'^    (\w+): \{', gs_schema, re.M)),
            set(re.findall(r'^        "(\w+)": \{', py_schema, re.M)))
    compare('score schema required',
            set(re.findall(r"'([^']*)'", _between(gs_schema, 'required: [', ']'))),
            set((probe.get('SCORE_SCHEMA') or {}).get('required', [])))
    compare('score schema additionalProperties',
            'additionalProperties: false' in gs_schema,
            (probe.get('SCORE_SCHEMA') or {}).get('additionalProperties') is False)

    # The five dimensions are the rubric. A dimension that exists in one file
    # and not the other is a scoring change nobody asked for.
    compare('score dimensions',
            set(re.findall(r"dim: '(\w+)'", cfg)),
            set((probe.get('SCORE_SCHEMA') or {}).get('properties', {}).keys())
            - {'why', 'salary_text', 'concerns'})

    # 2. Mirrored Config.gs values.
    for name, kind in (('API_VERSION', cfg_str), ('SCORE_MODEL', cfg_str),
                       ('DRAFT_MODEL', cfg_str), ('PARSE_MODEL', cfg_str),
                       ('BATCH_DISCOUNT', cfg_num), ('MAX_DESC_TOKENS', cfg_num)):
        expected = kind(name)
        actual = probe.get(name)
        compare(name, expected,
                type(expected)(actual) if actual is not None else None)

    gs_prices = dict((m, {'input': float(i), 'output': float(o)}) for m, i, o in
                     re.findall(r"'([\w.-]+)': \{ input: ([\d.]+), output: ([\d.]+) \}", cfg))
    compare('PRICE_PER_MTOK', gs_prices,
            dict((m, {'input': float(v['input']), 'output': float(v['output'])})
                 for m, v in (probe.get('PRICE_PER_MTOK') or {}).items()))

    # 3. The batch request params: top-level keys and max_tokens. This is what
    #    catches a dropped output_config - a difference the API accepts
    #    silently, and which only shows up as unparseable scores at 7am.
    gs_params = _between(gs, 'function scoreRequestParams_', 'function submitBatch_')
    compare('batch request keys',
            set(re.findall(r'^    (\w+):', gs_params, re.M)),
            set(re.findall(r'^        "(\w+)":', py_src[py_src.index('def batch_params('):], re.M)))
    compare('batch max_tokens',
            int(re.search(r'max_tokens: (\d+)', gs_params).group(1)),
            probe.get('BATCH_MAX_TOKENS'))

    return not fails


def run_logic_tests():
    """Load the sources in a browser and return window.results."""
    # geckodriver runs under snap confinement, which refuses this process's
    # SIGTERM. Selenium catches the resulting PermissionError, logs the whole
    # traceback and carries on (service.py: "does not raise itself ... but
    # ignores errors here") - so it prints after every test has already run and
    # passed, once at driver.quit() and once at exit. It made a green run look
    # like a failed one, which is worse than the leaked process it reports.
    logging.getLogger('selenium.webdriver.common.service').setLevel(logging.CRITICAL)

    opts = Options()
    opts.add_argument('-headless')
    # /usr/bin/firefox is a snap wrapper script, not an executable geckodriver
    # can launch; point at the real binary inside the snap.
    for candidate in ('/snap/firefox/current/usr/lib/firefox/firefox',
                      '/usr/lib/firefox/firefox', '/usr/bin/firefox-esr'):
        if os.path.exists(candidate):
            opts.binary_location = candidate
            break
    driver = webdriver.Firefox(options=opts)
    try:
        driver.get(build_page())
        load_error = driver.execute_script("return window.loadError;")
        if load_error:
            sys.exit("source threw while loading:\n" + load_error)
        return driver.execute_script("return window.results || null;")
    finally:
        driver.quit()


def main():
    results = run_logic_tests()
    if results is None:
        sys.exit("no results - a source file threw while loading")

    failed = [r for r in results if not r['pass']]
    drift_ok = check_probe_drift()
    for r in results:
        print(("  PASS  " if r['pass'] else "  FAIL  ") + r['name'])
        if not r['pass']:
            print("        " + r['err'])
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if (failed or not drift_ok) else 0)


if __name__ == '__main__':
    main()
