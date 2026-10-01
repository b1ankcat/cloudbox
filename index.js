const DEFAULT_SETTINGS = {
  proxy_prefix: "https://gh-proxy.org/",
  github_api: "https://api.github.com",
  request_timeout: 15,
  max_bytes: 3_000_000,
  max_repositories: 25,
  max_files_per_repository: 30,
  workers: 8,
  search_queries: [
    "tvbox pushed:{since}..{until}",
    "iptv tvbox pushed:{since}..{until}",
    "tvbox config pushed:{since}..{until}"
  ],
  known_urls: [
    "https://raw.githubusercontent.com/GD2021/TVBOX/main/datas/TVBOX%E7%BA%AF%E5%87%80%E7%89%88.json",
    "https://raw.githubusercontent.com/DodgeZhang/tvbox/main/aowu/aw.json",
    "https://raw.githubusercontent.com/DodgeZhang/tvbox/main/fantaiying/fty.json",
    "https://raw.githubusercontent.com/DodgeZhang/tvbox/main/feimao/fm.json",
    "https://raw.githubusercontent.com/SH2413/TVBOX-XIANLU/main/tvbox.json",
    "https://raw.githubusercontent.com/wangsu20M/tvbox/codex/tvbox-source-keeper/public/live.m3u"
  ]
};

const CONFIG_KEY = "config.json";
const REPORT_KEY = "discovered.json";

function settings() {
  return DEFAULT_SETTINGS;
}

function proxyUrl(value, prefix) {
  let url = String(value ?? "").trim().replace(/^['"<]|['">]$/g, "");
  if (!url || url.startsWith(prefix)) return url;
  const githubBlob = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.*)$/);
  if (githubBlob) url = `https://raw.githubusercontent.com/${githubBlob[1]}/${githubBlob[2]}/${githubBlob[3]}`;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (["raw.githubusercontent.com", "github.com", "www.github.com"].includes(host)) {
      return `${prefix.replace(/\/$/, "")}/${url}`;
    }
  } catch {
    return url;
  }
  return url;
}

async function requestText(url, timeoutSeconds, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "cloudbox-tvbox-discover/1.0", Accept: "*/*" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("response has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  } finally {
    clearTimeout(timer);
  }
}

async function githubJson(url, config) {
  return JSON.parse(await requestText(url, config.request_timeout, 5_000_000));
}

async function searchRepositories(config, since, until) {
  const found = new Map();
  for (const template of config.search_queries ?? []) {
    const query = template.replaceAll("{since}", since).replaceAll("{until}", until);
    const endpoint = `${config.github_api.replace(/\/$/, "")}/search/repositories?${new URLSearchParams({
      q: query,
      sort: "updated",
      order: "desc",
      per_page: String(config.max_repositories)
    })}`;
    try {
      const data = await githubJson(endpoint, config);
      for (const item of data.items ?? []) if (item.full_name) found.set(item.full_name, item);
    } catch (error) {
      console.warn("GitHub search skipped", String(error));
    }
  }
  return [...found.values()]
    .sort((a, b) => String(b.pushed_at ?? "").localeCompare(String(a.pushed_at ?? "")))
    .slice(0, Number(config.max_repositories));
}

async function repositoryCandidates(repo, config) {
  const [owner, name] = String(repo.full_name).split("/", 2);
  const branch = repo.default_branch || "main";
  const endpoint = `${config.github_api.replace(/\/$/, "")}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  try {
    const tree = (await githubJson(endpoint, config)).tree ?? [];
    const pattern = /(tvbox|vod|source|config|live|iptv|playlist|api).*(json|txt|m3u8?)$/i;
    const paths = tree
      .filter((item) => item.type === "blob" && pattern.test(item.path ?? ""))
      .map((item) => item.path)
      .sort((a, b) => (a.toLowerCase().includes("tvbox") ? -1 : 1) - (b.toLowerCase().includes("tvbox") ? -1 : 1) || a.length - b.length)
      .slice(0, Number(config.max_files_per_repository));
    return paths.map((path) => `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path.split("/").map(encodeURIComponent).join("/")}`);
  } catch (error) {
    console.warn(`Tree skipped for ${repo.full_name}`, String(error));
    return [];
  }
}

function jsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function classify(body) {
  const object = jsonObject(body);
  if (object && Array.isArray(object.sites)) return ["vod", object, `sites=${object.sites.length}`];
  if (object && Array.isArray(object.lives)) return ["live-config", object, `lives=${object.lives.length}`];
  if (body.slice(0, 500).includes("#EXTM3U") && /^https?:\/\//m.test(body)) {
    return ["m3u", null, `lines=${body.split("\n").length}`];
  }
  throw new Error("not a TVBox sites JSON, live JSON, or M3U playlist");
}

async function probe(url, config) {
  const candidate = proxyUrl(url, config.proxy_prefix);
  const result = { url, proxy_url: candidate };
  try {
    const body = await requestText(candidate, Number(config.request_timeout), Number(config.max_bytes));
    const [kind, object, detail] = classify(body);
    return { ...result, ok: true, kind, detail, _body: body, _object: object };
  } catch (error) {
    return { ...result, ok: false, error: String(error?.message ?? error) };
  }
}

async function probeAll(candidates, config) {
  const output = [];
  const workers = Math.max(1, Number(config.workers) || 1);
  for (let index = 0; index < candidates.length; index += workers) {
    const batch = candidates.slice(index, index + workers);
    output.push(...await Promise.all(batch.map((url) => probe(url, config))));
  }
  return output;
}

function resolveRef(value, baseUrl, config) {
  if (typeof value !== "string" || !value) return value;
  if (/^(csp_|py_|js_|clan:\/\/|file:\/\/)/.test(value)) return value;
  if (/^https?:\/\//.test(value)) return proxyUrl(value, config.proxy_prefix);
  if (/^(\.\.\/|\.\/)/.test(value) || /\.(jar|py|js)$/.test(value)) {
    try { return new URL(value, baseUrl).toString(); } catch { return value; }
  }
  return value;
}

function mergeResults(results, config) {
  const output = {
    notice: "Generated by cloudbox-tvbox-discover; verify playback on your network.",
    spider: "", wallpaper: "", sites: [], parses: [], lives: [], hosts: [], rules: [], doh: []
  };
  const siteKeys = new Set();
  const parseKeys = new Set();
  const liveKeys = new Set();
  results.forEach((result, resultIndex) => {
    if (!result.ok) return;
    const source = result.proxy_url;
    if (result.kind === "m3u") {
      if (!liveKeys.has(source)) {
        output.lives.push({ name: `Live ${resultIndex + 1}`, type: 0, url: source });
        liveKeys.add(source);
      }
      return;
    }
    const object = result._object ?? {};
    if (!output.spider && object.spider) output.spider = resolveRef(object.spider, source, config);
    if (!output.wallpaper && object.wallpaper) output.wallpaper = resolveRef(object.wallpaper, source, config);
    (object.sites ?? []).forEach((rawSite, siteIndex) => {
      if (!rawSite || typeof rawSite !== "object" || !rawSite.api) return;
      const originalKey = String(rawSite.key || `site_${siteIndex + 1}`);
      const key = `src${resultIndex + 1}_${originalKey}`;
      if (siteKeys.has(key)) return;
      const site = { ...rawSite, key, name: `[${resultIndex + 1}] ${rawSite.name || originalKey}` };
      site.api = resolveRef(site.api, source, config);
      for (const field of ["jar", "ext", "playUrl"]) if (field in site) site[field] = resolveRef(site[field], source, config);
      output.sites.push(site);
      siteKeys.add(key);
    });
    (object.parses ?? []).forEach((item) => {
      if (!item || typeof item !== "object" || !item.url) return;
      const parse = { ...item, url: resolveRef(item.url, source, config) };
      const identity = stableStringify(parse);
      if (!parseKeys.has(identity)) { output.parses.push(parse); parseKeys.add(identity); }
    });
    (object.lives ?? []).forEach((item) => {
      if (!item || typeof item !== "object" || !item.url) return;
      const live = { ...item, url: resolveRef(item.url, source, config) };
      const identity = stableStringify(live);
      if (!liveKeys.has(identity)) { output.lives.push(live); liveKeys.add(identity); }
    });
    for (const field of ["hosts", "rules", "doh"]) {
      for (const value of Array.isArray(object[field]) ? object[field] : []) if (!output[field].includes(value)) output[field].push(value);
    }
  });
  return output;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicResult(result) {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !key.startsWith("_")));
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

async function runDiscovery(env, scheduledAt = Date.now(), includeSearch = true) {
  const config = settings();
  const untilDate = new Date(scheduledAt + 86_400_000);
  const sinceDate = new Date(untilDate.getTime() - 30 * 86_400_000);
  const candidates = [...(config.known_urls ?? [])];
  if (includeSearch) {
    for (const repo of await searchRepositories(config, dateString(sinceDate), dateString(untilDate))) {
      candidates.push(...await repositoryCandidates(repo, config));
    }
  }
  const uniqueCandidates = [...new Set(candidates)];
  console.log(`Probing ${uniqueCandidates.length} candidates`);
  const results = await probeAll(uniqueCandidates, config);
  const valid = results.filter((item) => item.ok);
  const merged = mergeResults(valid, config);
  const report = {
    generated_at: new Date(scheduledAt).toISOString(),
    results: results.map(publicResult)
  };
  if (env.TVBOX_RESULTS) {
    await env.TVBOX_RESULTS.put(REPORT_KEY, JSON.stringify(report));
    if (valid.length > 0) await env.TVBOX_RESULTS.put(CONFIG_KEY, JSON.stringify(merged));
  }
  console.log(`Valid: ${valid.length}; sites: ${merged.sites.length}; lives: ${merged.lives.length}`);
  if (valid.length === 0) throw new Error("No valid TVBox candidates found");
  return { merged, report };
}

async function readJson(env, key, fallback) {
  if (!env.TVBOX_RESULTS) return fallback;
  const value = await env.TVBOX_RESULTS.get(key, "json");
  return value ?? fallback;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/config.json") {
      const value = await readJson(env, CONFIG_KEY, null);
      if (value) return Response.json(value, { headers: { "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
      try {
        const result = await runDiscovery(env, Date.now(), false);
        return Response.json(result.merged, { headers: { "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
      } catch (error) {
        return Response.json({ error: "Initial discovery failed", detail: String(error?.message ?? error) }, { status: 503 });
      }
    }
    if (url.pathname === "/discovered.json") {
      const value = await readJson(env, REPORT_KEY, { generated_at: null, results: [] });
      return Response.json(value, { headers: { "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDiscovery(env, controller.scheduledTime));
  }
};
