// Narrates every scene in script.json with one ElevenLabs voice → audio/<scene>.mp3 + audio/durations.json
//   npm run video:narrate -- <voice_id>        (FORCE=1 to regenerate existing clips)
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const voiceId = process.argv[2];
if (!voiceId) throw new Error("usage: npm run video:narrate -- <voice_id>");

const client = new ElevenLabsClient(); // reads ELEVENLABS_API_KEY, loaded by `node --env-file=../.env.local`
const { scenes } = JSON.parse(readFileSync("script.json", "utf8"));
const durationOf = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

mkdirSync("audio", { recursive: true });
const durations = {};
for (const [i, s] of scenes.entries()) {
  const file = `audio/${s.id}.mp3`;
  if (!existsSync(file) || process.env.FORCE) {
    const audio = await client.textToSpeech.convert(voiceId, {
      text: s.narration,
      modelId: "eleven_v4",
      outputFormat: "mp3_44100_128",
      voiceSettings: { stability: 0.7, similarityBoost: 0.5 }, // narration preset
      // Request stitching: neighbouring scenes keep tone continuous across cuts.
      previousText: scenes[i - 1]?.narration,
      nextText: scenes[i + 1]?.narration,
    });
    await finished(Readable.fromWeb(audio).pipe(createWriteStream(file)));
  }
  durations[s.id] = durationOf(file);
  console.log(`${s.id.padEnd(12)} ${durations[s.id].toFixed(1)} s`);
}
writeFileSync("audio/durations.json", JSON.stringify(durations, null, 2));
console.log(`total ${Object.values(durations).reduce((a, b) => a + b, 0).toFixed(1)} s`);
