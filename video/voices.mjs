// Lists the premade ElevenLabs voices this account can use, or renders a sample line for chosen ones.
//   npm run video:voices                  list premade voices
//   npm run video:voices -- <id> [<id>…]  write video/samples/<Name>.mp3
import { createWriteStream, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const client = new ElevenLabsClient(); // reads ELEVENLABS_API_KEY, loaded by `node --env-file=../.env.local`
const { voices } = await client.voices.getAll();
// Free plans can use premade voices through the API, not Voice Library ones.
const premade = voices.filter((v) => v.category === "premade");

const ids = process.argv.slice(2);
if (ids.length === 0) {
  for (const v of premade) {
    const l = v.labels ?? {};
    console.log([v.voiceId, v.name, l.gender, l.age, l.accent, l.description ?? l.descriptive, l.use_case].filter(Boolean).join(" | "));
  }
} else {
  mkdirSync("samples", { recursive: true });
  const text = "Proof of Edge. Forecasters get paid only when they beat the market... and a seller who copies the market earns exactly zero.";
  for (const id of ids) {
    const name = (premade.find((v) => v.voiceId === id)?.name ?? id).split(/[\s-]/)[0];
    const audio = await client.textToSpeech.convert(id, {
      text,
      modelId: "eleven_v4",
      outputFormat: "mp3_44100_128",
      voiceSettings: { stability: 0.7, similarityBoost: 0.5 }, // narration preset
    });
    await finished(Readable.fromWeb(audio).pipe(createWriteStream(`samples/${name}.mp3`)));
    console.log(`samples/${name}.mp3`);
  }
}
