import json, base64, urllib.request, sys

PAT = "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"
REPO = "yolocyq/xiamen-metro-line6-scheduler"
files = ["engine.js", "app.js", "seedc.js", ".gitignore"]

def api(path, data=None, method="GET"):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": f"Bearer {PAT}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json"},
        method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

for f in files:
    with open(f, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    sha = None
    try:
        sha = api(f"/repos/{REPO}/contents/{f}?ref=main")["sha"]
    except Exception as e:
        print(f, "GET sha 失败:", e)
    body = {"message": "安全加固: JS 混淆 (control-flow flatten + string-array)"}
    if sha:
        body["sha"] = sha
    body["content"] = b64
    res = api(f"/repos/{REPO}/contents/{f}", body, "PUT")
    print(f, "-> commit", res.get("commit", {}).get("sha", "?")[:7], "OK")
print("PUSH_DONE")
