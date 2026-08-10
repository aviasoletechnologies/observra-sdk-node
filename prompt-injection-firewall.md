It's a well-architected project worth learning from. It's a Go reverse proxy with an ensemble detection engine: 129 regex patterns in YAML rule files mapped to OWASP LLM Top 10, plus a fine-tuned DistilBERT ONNX classifier, combined via configurable strategies (any-match / majority / weighted with regex 0.6 + ML 0.4). Small project (3 stars) so don't treat it as battle-tested, but the design decisions are genuinely good.

## What's worth stealing for Observra

**YAML rule files by category** (owasp-llm-top10.yaml, jailbreak-patterns.yaml, data-exfil.yaml) — much better than my hardcoded regex array from earlier. Rules become data: users can review, extend, contribute, and you can ship rule updates without SDK releases. Each rule has id, category, severity, pattern, and OWASP tags — this maps beautifully to your tracing (every detection event carries a rule ID and OWASP category in the span attributes, which is a great selling point for compliance-minded customers).

**Three actions: block (403), flag (forward with X-PIF-Flagged/X-PIF-Score headers), log (silent passthrough)** — same as my block/flag/sanitize suggestion, validates that approach.

**Allowlist by regex patterns and SHA-256 hashes of trusted inputs** — smart, cheap way to eliminate false positives on known-good prompts. Also SHA-256 input hashing for audit/dedup.

**Adaptive per-client thresholds with EWMA tracking** — clients sending suspicious traffic get progressively stricter thresholds. Clever, and Observra already has per-client identity from tracing.

**Multi-tenant policies via header + config map, and replay/forensics (captured prompts stored as JSONL, re-scannable from a dashboard)** — replay is a killer feature for you specifically: when you update rules, rescan historical flagged traffic. That's observability + security combined, exactly Observra's story.

**One thing to do differently:** it scans only regex + ML on raw text. Add NFKC normalization + zero-width stripping *before* matching (their encoding-attack patterns partially cover this but normalization is more robust), and scan tool/RAG messages, not just user messages.

## Yes, fully doable in Node.js

Every piece has a Node equivalent, and you're actually in a *better* position — PIF is a separate proxy requiring zero code changes, but you already own both an SDK and a gateway, so detection lives inside your existing pipeline with no extra hop.

| PIF (Go) | Node.js equivalent |
|---|---|
| YAML rules + Viper config | `yaml` package + your existing config |
| Go regex engine | Native `RegExp` (precompile at load) |
| DistilBERT ONNX + CGO | `onnxruntime-node` (official, no build pain) — can load the same ONNX models, even their published HuggingFace model `ogulcanaydogan/pif-distilbert-injection-classifier` or Prompt Guard 2 |
| Concurrent detectors | `Promise.all` |
| Prometheus /metrics | `prom-client` |
| JSONL replay store | Append stream + rotation |

Minimal version of their ensemble design in Node:

```ts
import { load } from "js-yaml";
import { readFileSync, readdirSync } from "fs";
import * as ort from "onnxruntime-node";
import { createHash } from "crypto";

interface Rule { id: string; category: string; severity: number; pattern: string; enabled: boolean; tags: string[]; compiled?: RegExp; }
interface Finding { ruleId: string; category: string; severity: number; matched: string; }
interface ScanResult { score: number; blocked: boolean; findings: Finding[]; inputHash: string; }

function loadRules(dir: string): Rule[] {
  return readdirSync(dir)
    .filter(f => f.endsWith(".yaml"))
    .flatMap(f => load(readFileSync(`${dir}/${f}`, "utf8")) as Rule[])
    .filter(r => r.enabled)
    .map(r => ({ ...r, compiled: new RegExp(r.pattern, "i") }));
}

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "");
}

function regexDetect(text: string, rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  for (const r of rules) {
    const m = r.compiled!.exec(text);
    if (m) findings.push({ ruleId: r.id, category: r.category, severity: r.severity, matched: m[0].slice(0, 60) });
  }
  return findings;
}

let session: ort.InferenceSession | null = null;
async function mlDetect(text: string): Promise<number> {
  if (!session) session = await ort.InferenceSession.create("./models/injection-classifier-int8.onnx");
  const { inputIds, attentionMask } = tokenize(text);
  const out = await session.run({
    input_ids: new ort.Tensor("int64", inputIds, [1, inputIds.length]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, attentionMask.length]),
  });
  const [safe, injection] = softmax(Array.from(out.logits.data as Float32Array));
  return injection;
}

const WEIGHTS = { regex: 0.6, ml: 0.4 };

export async function scan(raw: string, threshold = 0.5): Promise<ScanResult> {
  const text = normalize(raw);
  const inputHash = createHash("sha256").update(text).digest("hex");

  const [findings, mlScore] = await Promise.all([
    Promise.resolve(regexDetect(text, rules)),
    mlEnabled ? mlDetect(text) : Promise.resolve(0),
  ]);

  const regexScore = findings.length ? Math.min(1, Math.max(...findings.map(f => f.severity)) / 4) : 0;
  const score = regexScore * WEIGHTS.regex + mlScore * WEIGHTS.ml;

  return { score, blocked: score >= threshold, findings, inputHash };
}
```

Practical notes:

- **Tokenization** is the annoying part in Node — DistilBERT needs WordPiece. Use `@huggingface/transformers` (transformers.js), which handles tokenizer + ONNX inference together and can run their model or ProtectAI's directly. Only drop to raw `onnxruntime-node` if you need to squeeze latency.
- **Run ML in a worker thread** — ONNX inference is CPU-bound and will block your gateway's event loop otherwise. Go gets this for free with goroutines; in Node you need `worker_threads` or a small pool.
- **Precompile all 129 regexes at startup**, and consider `re2` (node-re2) instead of native RegExp if you accept user-contributed rules — protects your gateway from ReDoS via malicious patterns.
- Their license is Apache-2.0, so you can port their YAML rule files directly with attribution — that's 129 curated patterns you don't have to write.

Suggested path: v1 = YAML regex rules + normalization + block/flag/log + trace events (pure JS, zero deps beyond yaml, ships in days). v2 = ONNX classifier in a worker + adaptive thresholds. v3 = replay/rescan from your dashboard. That sequencing matches their own roadmap and gives you something demo-able immediately.