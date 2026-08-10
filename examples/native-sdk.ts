/**
 * Recommended path: keep your own provider SDK exactly as-is.
 * `instrument()` reroutes its traffic through the Observra gateway.
 *
 * Installed from npm this import is:  import * as observra from "observra";
 *
 * Run:
 *   OBSERVRA_GATEWAY_URL=http://localhost:8787 \
 *   OBSERVRA_GATEWAY_KEY=obs_... GROQ_API_KEY=gsk_... \
 *   npx tsx examples/native-sdk.ts
 */
import Groq from "groq-sdk";
import * as observra from "../src/index.js";

observra.configure({
  gatewayUrl: process.env.OBSERVRA_GATEWAY_URL ?? "http://localhost:8787",
  gatewayKey: process.env.OBSERVRA_GATEWAY_KEY!,
  serviceName: "example-native-sdk",
  insecure: true, // local dev only; drop this for an https:// gateway
});
await observra.instrument();

// Stock construction, straight from Groq's own docs - no baseURL, no headers.
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const response = await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Say hello in one word." }],
});

console.log(response.choices[0].message.content);
