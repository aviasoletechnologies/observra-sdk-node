/**
 * Alternative path: Observra's own client classes, so you don't install a
 * provider SDK at all. No `instrument()` call needed - these route through
 * the gateway by construction.
 *
 * Installed from npm this import is:  import * as observra from "observra";
 *
 * Run:
 *   OBSERVRA_GATEWAY_KEY=obs_... GROQ_API_KEY=gsk_... \
 *   npx tsx examples/wrapper-classes.ts
 */
import * as observra from "../src/index.js";

observra.configure({
  gatewayUrl: process.env.OBSERVRA_GATEWAY_URL ?? "http://localhost:8787",
  gatewayKey: process.env.OBSERVRA_GATEWAY_KEY!,
  serviceName: "example-wrapper",
  insecure: true,
});

// OpenAI-shaped: same for Groq, OpenAI, Mistral, Together, Cohere, and every
// other provider the gateway fronts with the OpenAI protocol.
const groq = new observra.Groq({ apiKey: process.env.GROQ_API_KEY! });
const chat = (await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Say hello in one word." }],
})) as { choices: { message: { content: string } }[] };
console.log("groq:", chat.choices[0].message.content);

// Streaming - same call with `stream: true`.
const stream = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Count to three." }],
  stream: true,
});
let streamed = "";
for await (const chunk of stream) {
  streamed += (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
}
console.log("groq (streamed):", streamed);

// Gemini keeps its own native shape, matching @google/genai.
if (process.env.GEMINI_API_KEY) {
  const gemini = new observra.Gemini({ apiKey: process.env.GEMINI_API_KEY });
  try {
    const res = await gemini.models.generateContent({
      model: "gemini-2.0-flash",
      contents: "Say hello in one word.",
    });
    console.log("gemini:", res.text);
  } catch (err) {
    // Anything the gateway or provider rejects arrives as GatewayError, with
    // the upstream message intact - quota, billing, bad key, and so on.
    if (err instanceof observra.GatewayError) console.log(`gemini: [${err.status}] ${err.message.split("\n")[0]}`);
    else throw err;
  }
}
